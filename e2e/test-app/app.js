// A minimal Sidechain App: it finds the wallet only through the `client` library's discovery.
// Tests drive it through `window.testApp`.
import { discoverProviders } from "@ecx/client";

let provider;

window.testApp = {
  /** Discovers wallets (`options` as `discoverProviders` takes them); returns what an outsider can see about them. */
  async discover(options) {
    const found = await discoverProviders(options);
    provider = found[0]?.provider;
    return found.map(({ info }) => info);
  },

  /** True if any own property of `window` holds the discovered Provider. */
  providerIsOnWindow() {
    return Object.getOwnPropertyNames(window).some((name) => {
      try {
        return window[name] === provider;
      } catch {
        return false;
      }
    });
  },

  /** Each Provider event this page has received since `listen`, as `[event, payload]`. */
  events: [],

  /** Starts recording `event` into `events`. */
  async listen(event) {
    if (!provider) await this.discover();
    provider.on(event, (payload) => this.events.push([event, payload]));
  },

  /**
   * Shows a button that makes this request when clicked, as an app must for the web wallet's first
   * request (it opens a popup). Its answer lands in `clicked`, as `request` returns it.
   */
  arm(method, params) {
    const button = Object.assign(document.createElement("button"), { textContent: method });
    button.dataset.arm = "";
    button.addEventListener("click", () => {
      button.remove();
      this.clicked = this.request(method, params);
    }, { once: true });
    document.body.append(button);
  },

  /** Calls `provider.request` and returns `{ result }` or `{ error: { code, message } }`. */
  async request(method, params) {
    if (!provider) await this.discover();
    try {
      return { result: await provider.request({ method, params }) };
    } catch (error) {
      return { error: { code: error.code, message: error.message } };
    }
  },
};
