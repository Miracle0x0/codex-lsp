import type { LanguageConfig, ServerConfig } from "./schema.js";

const NODE_ROOTS = ["tsconfig.json", "jsconfig.json", "package.json"];
const PYTHON_ROOTS = ["pyproject.toml", "pyrightconfig.json", "setup.py", "setup.cfg", "requirements.txt"];
const JVM_ROOTS = ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"];
const NPM = (pkg: string): string => `npm install -g ${pkg}`;

/**
 * Built-in servers launched from the project's installed SDK instead of their command alone; see
 * `src/core/runtime/typescript.ts`. A user or project definition with the same id replaces this behaviour.
 */
export const SDK_SELECTED_SERVERS: ReadonlySet<string> = new Set(["typescript"]);

/** Built-in server definitions. Languages route to one default server; extra sources come from user config. */
export const BUILTIN_SERVERS: Readonly<Record<string, ServerConfig>> = {
	typescript: {
		command: ["typescript-language-server", "--stdio"],
		rootMarkers: NODE_ROOTS,
		installHint: `${NPM("typescript-language-server")} and add typescript to the project`,
		// The default "auto" answers definition, references, hover, and rename from a single-file syntax
		// server while the project loads, which silently drops cross-file results.
		initializationOptions: { tsserver: { useSyntaxServer: "never" } },
	},
	deno: {
		command: ["deno", "lsp"],
		rootMarkers: ["deno.json", "deno.jsonc"],
		installHint: "Install Deno from https://deno.land",
	},
	eslint: {
		command: ["vscode-eslint-language-server", "--stdio"],
		rootMarkers: NODE_ROOTS,
		installHint: NPM("vscode-langservers-extracted"),
	},
	oxlint: { command: ["oxlint", "--lsp"], rootMarkers: NODE_ROOTS, installHint: NPM("oxlint") },
	biome: {
		command: ["biome", "lsp-proxy", "--stdio"],
		rootMarkers: ["biome.json", "biome.jsonc", "package.json"],
		installHint: NPM("@biomejs/biome"),
	},
	vue: {
		command: ["vue-language-server", "--stdio"],
		rootMarkers: NODE_ROOTS,
		installHint: NPM("@vue/language-server"),
	},
	svelte: {
		command: ["svelteserver", "--stdio"],
		rootMarkers: NODE_ROOTS,
		installHint: NPM("svelte-language-server"),
	},
	astro: { command: ["astro-ls", "--stdio"], rootMarkers: NODE_ROOTS, installHint: NPM("@astrojs/language-server") },
	pyright: {
		command: ["pyright-langserver", "--stdio"],
		rootMarkers: PYTHON_ROOTS,
		installHint: "pip install pyright",
	},
	basedpyright: {
		command: ["basedpyright-langserver", "--stdio"],
		rootMarkers: PYTHON_ROOTS,
		installHint: "pip install basedpyright",
	},
	ty: { command: ["ty", "server"], rootMarkers: PYTHON_ROOTS, installHint: "pip install ty" },
	ruff: {
		command: ["ruff", "server"],
		rootMarkers: ["pyproject.toml", "ruff.toml", ".ruff.toml"],
		installHint: "pip install ruff",
	},
	gopls: {
		command: ["gopls"],
		rootMarkers: ["go.work", "go.mod"],
		installHint: "go install golang.org/x/tools/gopls@latest",
	},
	rust: {
		command: ["rust-analyzer"],
		rootMarkers: ["Cargo.toml", "rust-project.json"],
		installHint:
			"Install rust-analyzer and ensure it is in PATH. If using rustup: rustup component add rust-analyzer. " +
			"If rust-analyzer exits while loading rust-src: rustup component remove rust-src && rustup component add rust-src.",
	},
	clangd: {
		command: ["clangd", "--background-index", "--clang-tidy"],
		rootMarkers: ["compile_commands.json", "compile_flags.txt", ".clangd", "CMakeLists.txt", "meson.build"],
		installHint: "See https://clangd.llvm.org/installation",
	},
	jdtls: {
		command: ["jdtls"],
		rootMarkers: JVM_ROOTS,
		installHint: "See https://github.com/eclipse-jdtls/eclipse.jdt.ls",
	},
	"kotlin-ls": {
		command: ["kotlin-lsp"],
		rootMarkers: JVM_ROOTS,
		installHint: "See https://github.com/Kotlin/kotlin-lsp",
	},
	"ruby-lsp": {
		command: ["rubocop", "--lsp"],
		rootMarkers: ["Gemfile", ".rubocop.yml"],
		installHint: "gem install rubocop",
	},
	"elixir-ls": {
		command: ["elixir-ls"],
		rootMarkers: ["mix.exs"],
		installHint: "See https://github.com/elixir-lsp/elixir-ls",
	},
	zls: { command: ["zls"], rootMarkers: ["build.zig"], installHint: "See https://github.com/zigtools/zls" },
	csharp: {
		command: ["csharp-ls"],
		rootMarkers: ["*.sln", "*.csproj"],
		installHint: "dotnet tool install -g csharp-ls",
	},
	fsharp: {
		command: ["fsautocomplete"],
		rootMarkers: ["*.sln", "*.fsproj"],
		installHint: "dotnet tool install -g fsautocomplete",
	},
	"sourcekit-lsp": {
		command: ["sourcekit-lsp"],
		rootMarkers: ["Package.swift"],
		installHint: "Included with Xcode or the Swift toolchain",
	},
	bash: { command: ["bash-language-server", "start"], installHint: NPM("bash-language-server") },
	"yaml-ls": { command: ["yaml-language-server", "--stdio"], installHint: NPM("yaml-language-server") },
	"lua-ls": {
		command: ["lua-language-server"],
		rootMarkers: [".luarc.json"],
		installHint: "See https://github.com/LuaLS/lua-language-server",
	},
	php: { command: ["intelephense", "--stdio"], rootMarkers: ["composer.json"], installHint: NPM("intelephense") },
	dart: {
		command: ["dart", "language-server", "--lsp"],
		rootMarkers: ["pubspec.yaml"],
		installHint: "Included with the Dart SDK",
	},
	terraform: { command: ["terraform-ls", "serve"], installHint: "See https://github.com/hashicorp/terraform-ls" },
	prisma: { command: ["prisma", "language-server"], rootMarkers: ["package.json"], installHint: NPM("prisma") },
	"ocaml-lsp": { command: ["ocamllsp"], rootMarkers: ["dune-project"], installHint: "opam install ocaml-lsp-server" },
	texlab: { command: ["texlab"], installHint: "See https://github.com/latex-lsp/texlab" },
	dockerfile: { command: ["docker-langserver", "--stdio"], installHint: NPM("dockerfile-language-server-nodejs") },
	gleam: {
		command: ["gleam", "lsp"],
		rootMarkers: ["gleam.toml"],
		installHint: "See https://gleam.run/getting-started/installing/",
	},
	"clojure-lsp": {
		command: ["clojure-lsp", "listen"],
		rootMarkers: ["deps.edn", "project.clj"],
		installHint: "See https://clojure-lsp.io/installation/",
	},
	nixd: { command: ["nixd"], rootMarkers: ["flake.nix"], installHint: "nix profile install nixpkgs#nixd" },
	tinymist: { command: ["tinymist"], installHint: "See https://github.com/Myriad-Dreamin/tinymist" },
	"haskell-language-server": {
		command: ["haskell-language-server-wrapper", "--lsp"],
		rootMarkers: ["stack.yaml", "cabal.project", "*.cabal"],
		installHint: "ghcup install hls",
	},
};

function route(server: string, extensions: string[], toolchain: LanguageConfig["toolchain"] = null): LanguageConfig {
	return { extensions, toolchain, semanticServer: server, diagnosticServers: [server] };
}

export const BUILTIN_LANGUAGES: Readonly<Record<string, LanguageConfig>> = {
	typescript: route("typescript", [".ts", ".tsx", ".mts", ".cts"], "node"),
	javascript: route("typescript", [".js", ".jsx", ".mjs", ".cjs"], "node"),
	vue: route("vue", [".vue"], "node"),
	svelte: route("svelte", [".svelte"], "node"),
	astro: route("astro", [".astro"], "node"),
	python: route("pyright", [".py", ".pyi"], "python"),
	go: route("gopls", [".go"], "go"),
	rust: route("rust", [".rs"], "rust"),
	cpp: route("clangd", [".c", ".cc", ".cpp", ".cxx", ".c++", ".h", ".hh", ".hpp", ".hxx", ".h++"], "cpp"),
	java: route("jdtls", [".java"], "java"),
	kotlin: route("kotlin-ls", [".kt", ".kts"], "java"),
	ruby: route("ruby-lsp", [".rb", ".rake", ".gemspec", ".ru"]),
	elixir: route("elixir-ls", [".ex", ".exs"]),
	zig: route("zls", [".zig", ".zon"]),
	csharp: route("csharp", [".cs"]),
	fsharp: route("fsharp", [".fs", ".fsi", ".fsx", ".fsscript"]),
	swift: route("sourcekit-lsp", [".swift"]),
	shell: route("bash", [".sh", ".bash", ".zsh", ".ksh"]),
	yaml: route("yaml-ls", [".yaml", ".yml"]),
	lua: route("lua-ls", [".lua"]),
	php: route("php", [".php"]),
	dart: route("dart", [".dart"]),
	terraform: route("terraform", [".tf", ".tfvars"]),
	prisma: route("prisma", [".prisma"]),
	ocaml: route("ocaml-lsp", [".ml", ".mli"]),
	latex: route("texlab", [".tex", ".bib"]),
	dockerfile: route("dockerfile", [".dockerfile"]),
	gleam: route("gleam", [".gleam"]),
	clojure: route("clojure-lsp", [".clj", ".cljs", ".cljc", ".edn"]),
	nix: route("nixd", [".nix"]),
	typst: route("tinymist", [".typ", ".typc"]),
	haskell: route("haskell-language-server", [".hs", ".lhs"]),
};
