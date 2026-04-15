import {
  defineBundledChannelEntry,
  loadBundledEntryExportSync,
} from "openclaw/plugin-sdk/channel-entry-contract";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";

export default defineBundledChannelEntry({
  id: "openclaw-weixin",
  name: "Weixin",
  description: "Weixin channel (getUpdates long-poll + sendMessage)",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./src/channel.js",
    exportName: "weixinPlugin",
  },
  configSchema: () =>
    buildChannelConfigSchema(
      loadBundledEntryExportSync(import.meta.url, {
        specifier: "./src/config/config-schema.js",
        exportName: "WeixinConfigSchema",
      }),
    ),
  runtime: {
    specifier: "./src/runtime.js",
    exportName: "setWeixinRuntime",
  },
  registerFull(api) {
    const { assertHostCompatibility } = loadBundledEntryExportSync(import.meta.url, {
      specifier: "./src/compat.js",
    });
    assertHostCompatibility(api.runtime?.version);

    const { registerWeixinHttpLoginRoutes } = loadBundledEntryExportSync(import.meta.url, {
      specifier: "./src/http-login.js",
    });
    registerWeixinHttpLoginRoutes(api);
  },
});
