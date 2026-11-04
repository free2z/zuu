import { isExternalContentUrl, openEventContentUrl } from "./eventContentUrl";

describe("openEventContentUrl", () => {
  it("routes a site path through the router", () => {
    const navigate = jest.fn();
    const assign = jest.fn();
    openEventContentUrl("/alice/zpage/abc", navigate, assign);
    expect(navigate).toHaveBeenCalledWith("/alice/zpage/abc");
    expect(assign).not.toHaveBeenCalled();
  });

  it("opens the e2e2z chat link as a real navigation", () => {
    const navigate = jest.fn();
    const assign = jest.fn();
    const link = "https://free2z.com/bridge/e2e2z/chat/#peer=alice";
    openEventContentUrl(link, navigate, assign);
    expect(assign).toHaveBeenCalledWith(link);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("does nothing without a url", () => {
    const navigate = jest.fn();
    const assign = jest.fn();
    openEventContentUrl(null, navigate, assign);
    openEventContentUrl("", navigate, assign);
    expect(navigate).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("only treats http(s) as external", () => {
    expect(isExternalContentUrl("HTTPS://free2z.com/x")).toBe(true);
    expect(isExternalContentUrl("/https://free2z.com")).toBe(false);
    expect(isExternalContentUrl("javascript:alert(1)")).toBe(false);
  });
});
