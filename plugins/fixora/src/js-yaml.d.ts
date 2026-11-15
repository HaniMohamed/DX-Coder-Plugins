// Minimal typing for js-yaml 3.x (bundled dependency, parse only).
declare module "js-yaml" {
  export function safeLoad(text: string, options?: { json?: boolean }): unknown
  export function load(text: string, options?: { json?: boolean }): unknown
}
