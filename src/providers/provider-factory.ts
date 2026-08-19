import type { RuntimeConfig } from "../domain/config";
import { ConfigError } from "../domain/config";
import { DemoFaxProvider } from "./demo-fax-provider";
import type { FaxProvider } from "./fax-provider";
import { SinchFaxProvider } from "./sinch/sinch-fax-provider";
import { SignalWireFaxProvider } from "./signalwire/signalwire-fax-provider";

export function createFaxProvider(
  config: RuntimeConfig,
  options: { fetcher?: typeof fetch; demoProvider?: FaxProvider } = {},
): FaxProvider {
  if (config.provider === "demo") {
    return options.demoProvider ?? new DemoFaxProvider();
  }

  if (config.provider === "signalwire") {
    if (!config.signalwire) {
      throw new ConfigError(["SignalWire configuration is unavailable"]);
    }
    return new SignalWireFaxProvider({ ...config.signalwire, fetcher: options.fetcher });
  }

  if (!config.sinch) {
    throw new ConfigError(["Sinch configuration is unavailable"]);
  }

  return new SinchFaxProvider({ ...config.sinch, fetcher: options.fetcher });
}
