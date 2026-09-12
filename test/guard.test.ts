import { describe, expect, it } from "vitest";
import { checkRequest } from "../src/web/guard.js";

const base = {
  method: "GET",
  host: "127.0.0.1:8788",
  origin: undefined,
  guardHeader: undefined,
  remoteAddress: "127.0.0.1",
  port: 8788,
};

describe("dashboard request guard", () => {
  it("allows a normal local GET", () => {
    expect(checkRequest(base)).toEqual({ ok: true });
  });

  it("allows localhost and IPv6 loopback hosts", () => {
    expect(checkRequest({ ...base, host: "localhost:8788" }).ok).toBe(true);
    expect(checkRequest({ ...base, host: "[::1]:8788", remoteAddress: "::1" }).ok).toBe(true);
  });

  it("refuses a non-loopback client", () => {
    expect(checkRequest({ ...base, remoteAddress: "192.168.1.50" })).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses an unexpected Host, which is what DNS rebinding looks like", () => {
    expect(checkRequest({ ...base, host: "evil.example.com:8788" })).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses a cross-origin request even from loopback", () => {
    expect(checkRequest({ ...base, origin: "https://evil.example.com" })).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses a POST without the guard header, the CSRF case", () => {
    expect(checkRequest({ ...base, method: "POST" })).toMatchObject({ ok: false, status: 403 });
  });

  it("allows a POST carrying the guard header", () => {
    expect(checkRequest({ ...base, method: "POST", guardHeader: "1" })).toEqual({ ok: true });
  });

  it("still requires loopback for a POST that has the header", () => {
    expect(
      checkRequest({ ...base, method: "POST", guardHeader: "1", remoteAddress: "10.0.0.9" })
    ).toMatchObject({ ok: false, status: 403 });
  });
});
