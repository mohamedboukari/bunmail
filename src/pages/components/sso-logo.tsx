import { isEntraIssuerHost, type SsoProviderSettings } from "../../config/sso.ts";

/**
 * The logo on a login page "Sign in with <label>" button (#224). Static,
 * inline SVG markup only: no external request, no new dependency, nothing
 * the page's Content-Security-Policy has to allow beyond the page itself.
 */

/** Which logo a provider's button shows; `generic` is a neutral key. */
export type SsoLogoKind =
  "google" | "microsoft" | "gitlab" | "okta" | "auth0" | "keycloak" | "generic";

/**
 * The logo for a provider, chosen by its issuer's host (never by the
 * operator-chosen id, except for a self-hosted GitLab, whose host can be
 * anything): Google's issuer host, Microsoft Entra's (the global and
 * sovereign clouds), `gitlab.com` or the id `gitlab`, Okta's
 * (`*.okta.com`, `*.oktapreview.com`), Auth0's (`*.auth0.com`), any issuer
 * path with `/realms/` (Keycloak), and a neutral key for anything else.
 */
export function ssoLogoKind(
  provider: Pick<SsoProviderSettings, "id" | "issuer">,
): SsoLogoKind {
  let url: URL;
  try {
    url = new URL(provider.issuer);
  } catch {
    return provider.id === "gitlab" ? "gitlab" : "generic";
  }
  const host = url.hostname;
  if (host === "accounts.google.com") return "google";
  if (isEntraIssuerHost(host)) return "microsoft";
  if (host === "gitlab.com") return "gitlab";
  if (host.endsWith(".okta.com") || host.endsWith(".oktapreview.com")) return "okta";
  if (host.endsWith(".auth0.com")) return "auth0";
  if (provider.id === "gitlab") return "gitlab";
  if (url.pathname.includes("/realms/")) return "keycloak";
  return "generic";
}

/** Size and accessibility shared by every logo: decorative, the label names the provider. */
const LOGO_CLASS = "w-5 h-5 shrink-0";

/** The logo for `kind`, 20 by 20 pixels, hidden from assistive technology. */
export function SsoLogo({ kind }: { kind: SsoLogoKind }) {
  switch (kind) {
    case "google":
      return (
        <svg
          class={LOGO_CLASS}
          viewBox="0 0 48 48"
          aria-hidden="true"
          data-sso-logo="google"
        >
          <path
            fill="#EA4335"
            d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
          />
          <path
            fill="#4285F4"
            d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
          />
          <path
            fill="#FBBC05"
            d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
          />
          <path
            fill="#34A853"
            d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
          />
        </svg>
      );
    case "microsoft":
      return (
        <svg
          class={LOGO_CLASS}
          viewBox="0 0 21 21"
          aria-hidden="true"
          data-sso-logo="microsoft"
        >
          <rect x="1" y="1" width="9" height="9" fill="#F25022" />
          <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
          <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
          <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
        </svg>
      );
    case "gitlab":
      return (
        <svg
          class={LOGO_CLASS}
          viewBox="0 0 24 24"
          aria-hidden="true"
          data-sso-logo="gitlab"
        >
          <path
            fill="#FC6D26"
            d="m23.6 9.593-.033-.086L20.3.98a.851.851 0 0 0-.336-.405.875.875 0 0 0-1 .054.875.875 0 0 0-.29.44L16.47 7.818H7.537L5.333 1.07a.857.857 0 0 0-.29-.441.875.875 0 0 0-1-.054.859.859 0 0 0-.336.405L.433 9.502l-.032.086a6.066 6.066 0 0 0 2.012 7.01l.01.009.03.021 4.977 3.727 2.462 1.863 1.5 1.132a1.008 1.008 0 0 0 1.22 0l1.499-1.132 2.461-1.863 5.006-3.75.013-.01a6.068 6.068 0 0 0 2.01-7.002z"
          />
        </svg>
      );
    case "okta":
      return (
        <svg
          class={LOGO_CLASS}
          viewBox="0 0 24 24"
          aria-hidden="true"
          data-sso-logo="okta"
        >
          <path
            fill="#007DC1"
            d="M12 0C5.389 0 0 5.35 0 12s5.35 12 12 12 12-5.35 12-12S18.611 0 12 0zm0 18c-3.325 0-6-2.675-6-6s2.675-6 6-6 6 2.675 6 6-2.675 6-6 6z"
          />
        </svg>
      );
    case "auth0":
      return (
        <svg
          class={LOGO_CLASS}
          viewBox="0 0 24 24"
          aria-hidden="true"
          data-sso-logo="auth0"
        >
          <path
            fill="#EB5424"
            d="M21.98 7.448 19.62 0H4.347L2.02 7.448c-1.352 4.312.03 9.206 3.815 12.015L12.007 24l6.157-4.552c3.755-2.81 5.182-7.688 3.815-12.015l-6.16 4.58 2.343 7.45-6.157-4.597-6.158 4.58 2.358-7.433-6.188-4.55 7.63-.045L12.008 0l2.356 7.404 7.615.044z"
          />
        </svg>
      );
    case "keycloak":
      return (
        <svg
          class={LOGO_CLASS}
          viewBox="0 0 24 24"
          aria-hidden="true"
          data-sso-logo="keycloak"
        >
          <path fill="#4D4D4D" d="M12 1 21.5 6.5v11L12 23l-9.5-5.5v-11z" />
          <path
            fill="none"
            stroke="#00B8E3"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M10 8 6.5 12l3.5 4M14 8l3.5 4-3.5 4"
          />
        </svg>
      );
    case "generic":
      return (
        <svg
          class={LOGO_CLASS}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          stroke-width="1.5"
          aria-hidden="true"
          data-sso-logo="generic"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z"
          />
        </svg>
      );
  }
}
