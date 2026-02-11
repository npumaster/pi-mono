/**
 * 根据 Node.js 中基于 `fetch` 的 SDK 的环境变量设置 HTTP 代理。
 * Bun 内置了对此的支持。
 *
 * 任何需要 fetch() 代理支持的代码都应尽早导入此模块。
 * ES 模块已被缓存，因此多次导入是安全的 - 设置仅运行一次。
 */
if (typeof process !== "undefined" && process.versions?.node) {
	import("undici").then((m) => {
		const { EnvHttpProxyAgent, setGlobalDispatcher } = m;
		setGlobalDispatcher(new EnvHttpProxyAgent());
	});
}
