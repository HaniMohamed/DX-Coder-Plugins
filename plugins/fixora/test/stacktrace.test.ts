import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseStackTrace, splitException } from "../src/stacktrace/index.js"
import { isObfuscatedClass } from "../src/stacktrace/jvm.js"
import { cleanJsPath, isMinifiedJs } from "../src/stacktrace/js.js"
import { symbolicationCheck } from "../src/normalize.js"

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "traces", name), "utf8")

describe("parseStackTrace", () => {
  test("dart / flutter", () => {
    const r = parseStackTrace(fixture("dart.txt"), { appPackage: "my_app" })
    expect(r.language).toBe("dart")
    expect(r.exceptionType).toBe("_TypeError")
    expect(r.message).toContain("Null check operator")
    expect(r.frames[0]).toMatchObject({ file: "cart/service.dart", line: 88, column: 12, function: "CartService.applyCoupon", package: "my_app", inApp: true })
    expect(r.frames.find((f) => f.file?.includes("framework.dart"))?.inApp).toBe(false)
    expect(r.frames.find((f) => f.file === "dart:async/zone.dart")?.inApp).toBe(false)
    const web = parseStackTrace("package:my_app/ui/home.dart 12:5   HomePage.build\npackages/flutter/src/widgets/framework.dart 100:1  Element.rebuild")
    expect(web.language).toBe("dart")
    expect(web.frames[0]).toMatchObject({ file: "ui/home.dart", line: 12, function: "HomePage.build" })
  })

  test("kotlin / java with Caused by chain and app package", () => {
    const r = parseStackTrace(fixture("kotlin.txt"), { appPackage: "com.example.app" })
    expect(r.language).toBe("jvm")
    expect(r.exceptionType).toBe("java.lang.IllegalStateException")
    expect(r.message).toContain("coupon not loaded")
    expect(r.frames[0]).toMatchObject({ file: "CartRepository.kt", line: 88, function: "load", module: "com.example.app.cart.CartRepository", inApp: true })
    expect(r.frames.find((f) => f.module?.startsWith("kotlinx"))?.inApp).toBe(false)
    expect(isObfuscatedClass("a.b.c")).toBe(true)
    expect(isObfuscatedClass("com.example.app.cart.CartRepository")).toBe(false)
  })

  test("swift symbolicated and crashlytics console format", () => {
    const r = parseStackTrace(fixture("swift.txt"))
    expect(r.language).toBe("apple")
    expect(r.exceptionType).toBe("NSInvalidArgumentException")
    expect(r.message).toContain("unrecognized selector")
    const app = r.frames.filter((f) => f.inApp)
    expect(app[0]).toMatchObject({ file: "PaymentSheet.swift", line: 142, function: "PaymentSheet.present(amount:)", module: "MyApp" })
    expect(r.frames.find((f) => f.module === "UIKitCore")?.inApp).toBe(false)
    const console = parseStackTrace("Fatal Exception: NSRangeException\nindex 3 beyond bounds\nCheckout.swift line 40\nCheckout.pay()\nCartView.swift line 12\nCartView.body.getter")
    expect(console.frames[0]).toMatchObject({ file: "Checkout.swift", line: 40, function: "Checkout.pay()" })
  })

  test("javascript / typescript (V8 and Firefox)", () => {
    const r = parseStackTrace(fixture("node.txt"))
    expect(r.language).toBe("js")
    expect(r.exceptionType).toBe("TypeError")
    expect(r.frames[0]).toMatchObject({ file: "src/cart/service.ts", line: 88, column: 21, function: "applyCoupon", inApp: true })
    expect(r.frames.find((f) => f.file?.includes("node_modules"))?.inApp).toBe(false)
    const ff = parseStackTrace("TypeError: x is undefined\napplyCoupon@webpack:///./src/cart/service.ts:88:21\nrender@https://shop.example.com/static/app.js:10:5")
    expect(ff.frames[0]).toMatchObject({ file: "src/cart/service.ts", line: 88, function: "applyCoupon" })
    expect(cleanJsPath("webpack-internal:///./src/x.ts?abc")).toBe("src/x.ts")
    expect(isMinifiedJs([{ raw: "", file: "index.android.bundle", line: 1, column: 234567, function: "t", inApp: true }])).toBe(true)
    expect(symbolicationCheck("js", [{ raw: "", file: "main.3f2a1c9b.js", line: 1, column: 90000, function: "a", inApp: true }])).toBe("minified")
  })

  test("python traceback reversed to innermost first", () => {
    const r = parseStackTrace(fixture("python.txt"))
    expect(r.language).toBe("python")
    expect(r.exceptionType).toBe("AttributeError")
    expect(r.frames[0]).toMatchObject({ file: "/app/shop/cart.py", line: 88, function: "apply_coupon", inApp: true })
    expect(r.frames.find((f) => f.file?.includes("site-packages"))?.inApp).toBe(false)
  })

  test("go panic", () => {
    const r = parseStackTrace(fixture("go.txt"))
    expect(r.language).toBe("go")
    expect(r.exceptionType).toBe("runtime.Error")
    expect(r.message).toContain("nil pointer")
    expect(r.frames[0]).toMatchObject({ file: "/src/shop/cart/service.go", line: 88, function: "github.com/acme/shop/cart.(*Service).Apply", inApp: true })
    expect(r.frames.some((f) => f.function?.startsWith("runtime."))).toBe(false)
  })

  test(".net", () => {
    const r = parseStackTrace(fixture("dotnet.txt"))
    expect(r.language).toBe("dotnet")
    expect(r.exceptionType).toBe("System.NullReferenceException")
    expect(r.frames[0]).toMatchObject({ file: "C:/src/shop/Cart/CartService.cs", line: 88, function: "ApplyCoupon", inApp: true })
    expect(r.frames.find((f) => f.module?.startsWith("System."))?.inApp).toBe(false)
  })

  test("rust falls back to the generic parser", () => {
    const r = parseStackTrace(fixture("rust.txt"))
    expect(r.language).toBe("unknown")
    expect(r.frames[0]).toMatchObject({ file: "src/cart/service.rs", line: 88 })
  })

  test("obfuscated android is detected", () => {
    const r = parseStackTrace(fixture("java-obfuscated.txt"), { appPackage: "a" })
    expect(symbolicationCheck("jvm", r.frames)).toBe("obfuscated")
  })

  test("language hint forces a parser; splitException", () => {
    const r = parseStackTrace("    at foo (x.ts:1:1)", { language: "js" })
    expect(r.language).toBe("js")
    expect(splitException("TypeError: boom")).toEqual({ exceptionType: "TypeError", message: "boom" })
    expect(splitException("just a message")).toEqual({ message: "just a message" })
  })
})
