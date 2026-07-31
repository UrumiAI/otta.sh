import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		name: "admin-react",
		// `.tsx` as well as `.ts` — this is the one package that compiles JSX, so
		// a component test named `foo.test.tsx` is the obvious thing to write and
		// a `.ts`-only glob would SILENTLY not run it. That is the same
		// silent-drop failure mode the console's own tests police in the admin
		// sidebar (a declared page with no component simply vanishes); it should
		// not be reintroduced by the test runner's own config.
		include: ["test/**/*.test.{ts,tsx}"],
	},
});
