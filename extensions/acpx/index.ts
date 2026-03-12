import type { OpenClawPluginApi } from "openclaw/plugin-sdk/acpx";
import { createAcpxPluginConfigSchema } from "./src/config.ts";
import { createAcpxRuntimeService } from "./src/service.ts";

const plugin = {
  id: "acpx",
  name: "ACPX Runtime",
  description: "ACP runtime backend powered by the acpx CLI.",
  configSchema: createAcpxPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerService(
      createAcpxRuntimeService({
        pluginConfig: api.pluginConfig,
      }),
    );
  },
};

export default plugin;
