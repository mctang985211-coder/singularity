import { Context } from "@deepseek-ai/cordis";

//#region src/index.d.ts
declare module '@deepseek-ai/cordis' {
  interface Events {
    'pr-chat/path': (event: unknown) => void;
    'pr-chat/sent': (event: unknown) => void;
  }
}
declare const name = "graph-web";
declare const inject: string[];
declare function apply(ctx: Context): void;
//#endregion
export { apply, inject, name };