import { missingChalybEnvVars, readChalybEnv } from "@/lib/env";

interface LoginPageProps {
  searchParams: Promise<{ next?: string; error?: string }>;
}

/**
 * Login is just a redirect-to-Chalyb bounce. We don't host credentials
 * here — Chalyb mints an SSO token and the browser lands back on
 * /auth/sso?token=... which sets our session cookie.
 *
 * When env vars are missing this page surfaces the exact var names so
 * operators see what to set in Vercel without having to read logs.
 */
export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { error } = await searchParams;
  const env = readChalybEnv();
  const missing = missingChalybEnvVars();
  const configured = env !== null;

  return (
    <div className="flex-1 flex items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold mb-2">Entrar a ChalyOBS</h1>
          <p className="text-text-tertiary text-sm">
            Inicia sesión desde Chalyb.
          </p>
        </div>

        {!configured && (
          <div className="mb-5 p-3 rounded-lg bg-warn/10 border border-warn/40 text-xs text-text-secondary">
            <strong className="text-warn block mb-1">
              Servicio no configurado.
            </strong>
            Faltan variables de entorno en el servidor. ChalyOBS no puede
            iniciar sesión hasta que estén definidas:
            <ul className="mt-1 ml-4 list-disc font-mono text-[11px]">
              {missing.map((v) => (
                <li key={v}>{v}</li>
              ))}
            </ul>
          </div>
        )}

        {configured && (
          <a
            href={buildChalybLoginUrl(env)}
            className="w-full flex items-center justify-center gap-3 py-3 rounded-lg bg-accent text-white hover:opacity-90 transition text-sm font-semibold"
          >
            Continuar con Chalyb →
          </a>
        )}

        {error && (
          <div className="mt-4 text-xs text-bad bg-bad/10 border border-bad/30 rounded-md p-2 break-words">
            <strong>No pudimos iniciar tu sesión.</strong>{" "}
            {ssoErrorText(error)}{" "}
            {/* Raw reason kept for operators; searchParams arrive decoded —
                decoding again threw URIError on a stray "%". */}
            <span className="font-mono opacity-70">({error})</span>
          </div>
        )}

        <p className="mt-8 text-center text-[11px] text-text-tertiary">
          ChalyOBS es un agente de Chalyb — tu sesión vive ahí.
        </p>
      </div>
    </div>
  );
}

/** Spanish copy for the /auth/sso failure reasons (SsoTokenError messages
 *  and the route's own codes). Unknown reasons fall back to a generic line. */
function ssoErrorText(reason: string): string {
  switch (reason) {
    case "token expired":
      return "El enlace de acceso venció. Vuelve a entrar desde Chalyb.";
    case "missing_token":
    case "empty token":
      return "Falta el enlace de acceso. Entra desde Chalyb.";
    case "service_not_configured":
      return "El servicio no está configurado todavía.";
    default:
      return "El enlace de acceso no es válido. Vuelve a entrar desde Chalyb.";
  }
}

function buildChalybLoginUrl(
  env: NonNullable<ReturnType<typeof readChalybEnv>>,
): string {
  // The hub's launcher signs the person in if needed (/sign-in?next=…), then
  // mints the SSO token and lands them on our /auth/sso → /dashboard. Its
  // /login → /sign-in ignores engine/return_to, so linking there left people
  // on chalyb.com instead of coming back here.
  const hub = process.env.CHALYB_BASE_URL?.trim() || new URL(env.chalybLoginUrl).origin;
  return new URL("/auth/launch/chalybobs", hub).toString();
}
