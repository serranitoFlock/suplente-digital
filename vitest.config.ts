import { configDefaults, defineConfig } from "vitest/config";

// The Angular admin panel (admin/) has its own test runner (`ng test`); keep it out of the root suite.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "admin/**"] },
});
