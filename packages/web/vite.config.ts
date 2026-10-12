import { defineConfig } from "vite";

export default defineConfig({
	build: {
		outDir: "dist",
		emptyOutDir: true,
		target: "es2023",
	},
	server: {
		port: 5173,
	},
});
