import { describe, expect, it } from "vitest";

import { ConfigError, parseRuntimeConfig, toPublicConfig } from "./config";

const demoEnv = {
  APP_NAME: "House Fax",
  AUTH_MODE: "dev",
  FAX_PROVIDER: "demo",
  DEFAULT_FORWARD_EMAIL: "fax@example.com",
  PREFERRED_AREA_CODES: "615,629",
  DEFAULT_TTL_DAYS: "3",
  TTL_PRESETS: "1,3,7,14",
  MAX_TTL_DAYS: "365",
  DEFAULT_RETENTION: "forever",
  LOG_DETAIL: "full",
  MAX_UPLOAD_BYTES: "26214400",
  MAX_FAX_PAGES: "100",
  DEFAULT_RENTAL_MONTHS: "1",
  RENTAL_MONTH_PRESETS: "1,2,3",
  MAX_RENTAL_MONTHS: "12",
};

describe("parseRuntimeConfig", () => {
  it("normalizes a generic demo configuration", () => {
    const config = parseRuntimeConfig(demoEnv);

    expect(config.preferredAreaCodes).toEqual(["615", "629"]);
    expect(config.ttlPresets).toEqual([1, 3, 7, 14]);
    expect(config.retention).toEqual({ mode: "forever" });
    expect(config.provider).toBe("demo");
    expect(config.isDemo).toBe(true);
    expect(config.defaultRentalMonths).toBe(1);
    expect(config.rentalMonthPresets).toEqual([1, 2, 3]);
    expect(config.defaultPhoneCountry).toBe("US");
    expect(config.maxEmailAttachmentBytes).toBe(18_000_000);
  });

  it("publishes a configured default phone country", () => {
    const config = parseRuntimeConfig({
      ...demoEnv,
      DEFAULT_PHONE_COUNTRY: "GB",
    });

    expect(toPublicConfig(config).defaultPhoneCountry).toBe("GB");
  });

  it("rejects an unsupported default phone country", () => {
    expect(() =>
      parseRuntimeConfig({
        ...demoEnv,
        DEFAULT_PHONE_COUNTRY: "ZZ",
      }),
    ).toThrow(ConfigError);
  });

  it("requires production Sinch and Access values", () => {
    expect(() =>
      parseRuntimeConfig({
        ...demoEnv,
        AUTH_MODE: "access",
        FAX_PROVIDER: "sinch",
      }),
    ).toThrow(ConfigError);
  });

  it("accepts a complete production configuration", () => {
    const config = parseRuntimeConfig({
      ...demoEnv,
      AUTH_MODE: "access",
      FAX_PROVIDER: "sinch",
      APP_BASE_URL: "https://fax.example.com",
      CF_ACCESS_AUD: "access-audience",
      CF_ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
      WEBHOOK_BASE_URL: "https://fax-events.example.com",
      WEBHOOK_USERNAME: "sinch",
      WEBHOOK_PASSWORD: "secret",
      SINCH_PROJECT_ID: "project-id",
      SINCH_SERVICE_ID: "service-id",
      SINCH_KEY_ID: "key-id",
      SINCH_KEY_SECRET: "key-secret",
      EMAIL_FROM_ADDRESS: "fax@example.com",
    });

    expect(config.provider).toBe("sinch");
    expect(config.auth.mode).toBe("access");
    expect(config.sinch?.serviceId).toBe("service-id");
    expect(config.email?.fromAddress).toBe("fax@example.com");
  });

  it("accepts SignalWire production credentials and a configured number estimate", () => {
    const config = parseRuntimeConfig({
      ...demoEnv,
      AUTH_MODE: "access",
      FAX_PROVIDER: "signalwire",
      APP_BASE_URL: "https://fax.example.com",
      CF_ACCESS_AUD: "access-audience",
      CF_ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
      WEBHOOK_BASE_URL: "https://fax-events.example.com",
      WEBHOOK_USERNAME: "signalwire",
      WEBHOOK_PASSWORD: "secret",
      SIGNALWIRE_PROJECT_ID: "project-id",
      SIGNALWIRE_API_TOKEN: "api-token",
      SIGNALWIRE_SPACE_URL: "family.signalwire.com",
      SIGNALWIRE_LOCAL_NUMBER_MONTHLY_PRICE: "0.50",
      SIGNALWIRE_ACCOUNT_MODE: "trial",
      EMAIL_FROM_ADDRESS: "fax@example.com",
    });

    expect(config.provider).toBe("signalwire");
    expect(config.signalwire).toEqual({
      projectId: "project-id",
      apiToken: "api-token",
      spaceUrl: "family.signalwire.com",
      localNumberMonthlyPrice: "0.50",
      accountMode: "trial",
      minimumNumberHoldDays: 30,
    });
    expect(toPublicConfig(config).minimumNumberHoldDays).toBe(30);
    expect(config.email?.fromAddress).toBe("fax@example.com");
  });

  it("uses SignalWire's funded-account release hold after Trial Mode ends", () => {
    const config = parseRuntimeConfig({
      ...demoEnv,
      FAX_PROVIDER: "signalwire",
      APP_BASE_URL: "https://fax.example.com",
      WEBHOOK_BASE_URL: "https://fax-events.example.com",
      WEBHOOK_USERNAME: "signalwire",
      WEBHOOK_PASSWORD: "secret",
      SIGNALWIRE_PROJECT_ID: "project-id",
      SIGNALWIRE_API_TOKEN: "api-token",
      SIGNALWIRE_SPACE_URL: "family.signalwire.com",
      SIGNALWIRE_LOCAL_NUMBER_MONTHLY_PRICE: "0.50",
      SIGNALWIRE_ACCOUNT_MODE: "funded",
      EMAIL_FROM_ADDRESS: "fax@example.com",
    });

    expect(config.signalwire?.minimumNumberHoldDays).toBe(14);
    expect(toPublicConfig(config).minimumNumberHoldDays).toBe(14);
  });

  it("accepts an explicit provider release hold", () => {
    const config = parseRuntimeConfig({
      ...demoEnv,
      FAX_PROVIDER: "signalwire",
      APP_BASE_URL: "https://fax.example.com",
      WEBHOOK_BASE_URL: "https://fax-events.example.com",
      WEBHOOK_USERNAME: "signalwire",
      WEBHOOK_PASSWORD: "secret",
      SIGNALWIRE_PROJECT_ID: "project-id",
      SIGNALWIRE_API_TOKEN: "api-token",
      SIGNALWIRE_SPACE_URL: "family.signalwire.com",
      SIGNALWIRE_LOCAL_NUMBER_MONTHLY_PRICE: "0.50",
      SIGNALWIRE_ACCOUNT_MODE: "funded",
      SIGNALWIRE_MINIMUM_NUMBER_HOLD_DAYS: "21",
      EMAIL_FROM_ADDRESS: "fax@example.com",
    });

    expect(config.signalwire?.minimumNumberHoldDays).toBe(21);
    expect(toPublicConfig(config).minimumNumberHoldDays).toBe(21);
  });

  it("requires every SignalWire production value", () => {
    expect(() =>
      parseRuntimeConfig({
        ...demoEnv,
        FAX_PROVIDER: "signalwire",
        APP_BASE_URL: "https://fax.example.com",
        WEBHOOK_BASE_URL: "https://fax-events.example.com",
        WEBHOOK_USERNAME: "signalwire",
        WEBHOOK_PASSWORD: "secret",
      }),
    ).toThrow(ConfigError);
  });

  it("rejects malformed area codes and TTLs", () => {
    expect(() =>
      parseRuntimeConfig({
        ...demoEnv,
        PREFERRED_AREA_CODES: "61,abc",
        TTL_PRESETS: "0,3",
      }),
    ).toThrow(ConfigError);
  });

  it("rejects invalid month rental preferences", () => {
    expect(() =>
      parseRuntimeConfig({
        ...demoEnv,
        DEFAULT_RENTAL_MONTHS: "2",
        RENTAL_MONTH_PRESETS: "0,2",
        MAX_RENTAL_MONTHS: "1",
      }),
    ).toThrow(ConfigError);
  });

  it("rejects retention periods until automated purging exists", () => {
    expect(() =>
      parseRuntimeConfig({
        ...demoEnv,
        DEFAULT_RETENTION: "90",
      }),
    ).toThrow(ConfigError);
  });

  it("accepts an explicit email attachment limit", () => {
    const config = parseRuntimeConfig({
      ...demoEnv,
      MAX_EMAIL_ATTACHMENT_BYTES: "12500000",
    });

    expect(config.maxEmailAttachmentBytes).toBe(12_500_000);
  });
});

describe("toPublicConfig", () => {
  it("never exposes credentials", () => {
    const config = parseRuntimeConfig({
      ...demoEnv,
      AUTH_MODE: "access",
      FAX_PROVIDER: "sinch",
      APP_BASE_URL: "https://fax.example.com",
      CF_ACCESS_AUD: "access-audience",
      CF_ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
      WEBHOOK_BASE_URL: "https://fax-events.example.com",
      WEBHOOK_USERNAME: "sinch",
      WEBHOOK_PASSWORD: "secret",
      SINCH_PROJECT_ID: "project-id",
      SINCH_SERVICE_ID: "service-id",
      SINCH_KEY_ID: "key-id",
      SINCH_KEY_SECRET: "key-secret",
      EMAIL_FROM_ADDRESS: "fax@example.com",
    });

    expect(JSON.stringify(toPublicConfig(config))).not.toContain("key-secret");
    expect(JSON.stringify(toPublicConfig(config))).not.toContain("WEBHOOK_PASSWORD");
  });
});
