declare module 'bananamark' {
  export interface DemoDialect { readonly language: import('@codemirror/language').LanguageSupport; }
  export function defineDialect(options: {wikiLinks:boolean; bibliography:boolean; tikz:boolean}): DemoDialect;
}
declare module 'bananamark-codemirror' {
  export function bananamark(options: {
    dialect: import('bananamark').DemoDialect;
    locale: 'en';
    lint: false;
  }): import('@codemirror/state').Extension;
}
declare module '*/editor/dialect.js' {
  export const dialectOptions: {wikiLinks:boolean; bibliography:boolean; tikz:boolean};
}
