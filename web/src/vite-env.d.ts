/// <reference types="vite/client" />

// CSS modules are resolved by Vite at build time, so tsc needs to be told they
// exist and what shape they have. Typed as an index of class names rather than as
// `any`, so a typo in styles.someClass is still a compile error where the module
// declares its classes -- which for plain CSS modules it does not, so this is the
// honest limit: the names are checked to be strings, not to exist.
declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}
