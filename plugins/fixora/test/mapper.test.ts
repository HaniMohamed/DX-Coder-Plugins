import { describe, expect, test } from "bun:test"
import { buildIndex, mapFrames, mappability, packagePathToRepoPath, primaryPaths } from "../src/mapper.js"
import type { Frame } from "../src/types.js"

const frame = (o: Partial<Frame>): Frame => ({ raw: "", inApp: true, ...o })

const files = [
  "lib/cart/service.dart",
  "lib/ui/checkout.dart",
  "test/cart/service_test.dart",
  "android/app/src/main/java/com/example/app/cart/CartRepository.kt",
  "android/app/src/test/java/com/example/app/cart/CartRepositoryTest.kt",
  "src/cart/service.ts",
  "src/cart/service.test.ts",
  "packages/shared/src/cart/service.ts",
  "dist/cart/service.js",
  "ios/Runner/PaymentSheet.swift",
  "lib/generated/api.g.dart",
]
const index = buildIndex(files, "abc123")

describe("packagePathToRepoPath", () => {
  test("dart package paths, jvm classes, webpack paths, absolute paths", () => {
    expect(packagePathToRepoPath(frame({ file: "cart/service.dart", package: "my_app" }), { language: "dart", appPackage: "my_app" })).toEqual(["lib/cart/service.dart", "cart/service.dart"])
    expect(packagePathToRepoPath(frame({ file: "cart/x.dart", package: "shared" }), { language: "dart", appPackage: "my_app" })[1]).toBe("packages/shared/lib/cart/x.dart")
    expect(packagePathToRepoPath(frame({ file: "CartRepository.kt", module: "com.example.app.cart.CartRepository$load$1" }), { language: "jvm" })).toEqual(["com/example/app/cart/CartRepository.kt", "CartRepository.kt"])
    expect(packagePathToRepoPath(frame({ module: "com.example.app.cart.CartRepository" }), { language: "jvm" })).toEqual(["com/example/app/cart/CartRepository.kt", "com/example/app/cart/CartRepository.java"])
    expect(packagePathToRepoPath(frame({ file: "webpack:///./src/cart/service.ts" }), { language: "js" })[0]).toBe("src/cart/service.ts")
    expect(packagePathToRepoPath(frame({ file: "/app/src/cart/service.ts" }), { language: "js" })).toEqual(["app/src/cart/service.ts", "src/cart/service.ts"])
    expect(packagePathToRepoPath(frame({ file: "C:\\src\\shop\\Cart\\CartService.cs" }), { language: "dotnet" })[0]).toBe("src/shop/Cart/CartService.cs")
  })
})

describe("mapFrames", () => {
  test("ranks exact > suffix > basename, penalises tests and generated files, prefers package roots", () => {
    const mapped = mapFrames([frame({ file: "cart/service.dart", package: "my_app", line: 88 }), frame({ file: "CartRepository.kt", module: "com.example.app.cart.CartRepository", line: 10 }), frame({ file: "service.ts", line: 1 })], index, { language: "dart", appPackage: "my_app" })
    expect(mapped[0]!.candidates[0]).toMatchObject({ path: "lib/cart/service.dart", score: 1 })
    expect(mapped[0]!.candidates.find((c) => c.path === "test/cart/service_test.dart")).toBeUndefined()
    const jvm = mapFrames([frame({ file: "CartRepository.kt", module: "com.example.app.cart.CartRepository", line: 10 })], index, { language: "jvm" })
    expect(jvm[0]!.candidates[0]!.path).toBe("android/app/src/main/java/com/example/app/cart/CartRepository.kt")
    expect(jvm[0]!.candidates.map((c) => c.path)).not.toContain("android/app/src/test/java/com/example/app/cart/CartRepositoryTest.kt")
    const js = mapFrames([frame({ file: "service.ts" })], index, { language: "js" })
    const paths = js[0]!.candidates.map((c) => c.path)
    expect(paths[0]).toBe("src/cart/service.ts")
    expect(paths).toContain("packages/shared/src/cart/service.ts")
    expect(paths.some((p) => p.includes(".test."))).toBe(false)
    const generated = mapFrames([frame({ file: "service.js" })], index, { language: "js" })
    expect(generated[0]!.candidates[0]).toMatchObject({ path: "dist/cart/service.js", score: 0.3 })
    expect(generated[0]!.candidates[0]!.reason).toContain("-test/generated")
  })

  test("external frames keep candidates but are flagged; generated files are penalised", () => {
    const mapped = mapFrames([frame({ file: "api.g.dart", package: "my_app", inApp: false })], index, { language: "dart" })
    expect(mapped[0]!.external).toBe(true)
    expect(mapped[0]!.candidates[0]!.reason).toContain("-test/generated")
  })

  test("mappability and primaryPaths", () => {
    const high = mapFrames([frame({ file: "cart/service.dart", package: "my_app" }), frame({ file: "ui/checkout.dart", package: "my_app" })], index, { language: "dart" })
    expect(mappability(high)).toBe("high")
    expect(primaryPaths(high)).toEqual(["lib/cart/service.dart", "lib/ui/checkout.dart"])
    const none = mapFrames([frame({ file: "nowhere/else.dart", package: "my_app" })], index, { language: "dart" })
    expect(mappability(none)).toBe("none")
    const low = mapFrames([frame({ file: "zone.dart", inApp: false }), frame({ file: "service.ts" })], index, { language: "js" })
    expect(["high", "low"]).toContain(mappability(low))
  })
})
