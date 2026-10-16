import type { ToolchainKind } from "../config/schema.js";

/** Variables every snapshot records: process basics needed to start any language server. */
export const BASE_VARIABLES = [
	"PATH",
	"Path",
	"PATHEXT",
	"HOME",
	"USERPROFILE",
	"SystemRoot",
	"ComSpec",
	"TEMP",
	"TMP",
	"TMPDIR",
	"SHELL",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"XDG_CONFIG_HOME",
	"XDG_CACHE_HOME",
	"XDG_DATA_HOME",
	"APPDATA",
	"LOCALAPPDATA",
] as const;

/** Variables that select or configure each toolchain. Missing ones are recorded as removed. */
export const TOOLCHAIN_VARIABLES: Readonly<Record<ToolchainKind, readonly string[]>> = {
	python: [
		"VIRTUAL_ENV",
		"CONDA_PREFIX",
		"CONDA_DEFAULT_ENV",
		"CONDA_SHLVL",
		"CONDA_EXE",
		"CONDA_PYTHON_EXE",
		"PYTHONHOME",
		"PYTHONPATH",
		"PYTHONNOUSERSITE",
		"UV_PROJECT_ENVIRONMENT",
		"UV_PYTHON",
		"PYENV_VERSION",
		"PYENV_ROOT",
	],
	node: [
		"NODE_OPTIONS",
		"NODE_PATH",
		"NVM_DIR",
		"NVM_BIN",
		"VOLTA_HOME",
		"FNM_DIR",
		"FNM_MULTISHELL_PATH",
		"NODENV_VERSION",
	],
	rust: ["RUSTUP_TOOLCHAIN", "RUSTUP_HOME", "CARGO_HOME", "RUSTFLAGS", "CARGO_TARGET_DIR", "CARGO_BUILD_TARGET"],
	go: [
		"GOROOT",
		"GOPATH",
		"GOTOOLCHAIN",
		"GOWORK",
		"GOENV",
		"GOFLAGS",
		"GOOS",
		"GOARCH",
		"GO111MODULE",
		"GOPROXY",
		"GOPRIVATE",
		"GOMODCACHE",
		"CGO_ENABLED",
	],
	java: ["JAVA_HOME", "JDK_HOME", "GRADLE_USER_HOME", "MAVEN_OPTS", "JAVA_TOOL_OPTIONS"],
	cpp: [
		"CC",
		"CXX",
		"CFLAGS",
		"CXXFLAGS",
		"CPPFLAGS",
		"SDKROOT",
		"DEVELOPER_DIR",
		"MACOSX_DEPLOYMENT_TARGET",
		"CPATH",
		"C_INCLUDE_PATH",
		"CPLUS_INCLUDE_PATH",
		"LIBRARY_PATH",
		"PKG_CONFIG_PATH",
		"INCLUDE",
		"LIB",
	],
};

/** The full set of variable names a snapshot captures, plus configured extras. */
export function snapshotVariableNames(extra: readonly string[] = []): string[] {
	return [...new Set([...BASE_VARIABLES, ...Object.values(TOOLCHAIN_VARIABLES).flat(), ...extra])];
}
