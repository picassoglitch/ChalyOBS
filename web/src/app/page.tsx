import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/server-session";

/**
 * Root — ChalyOBS has no public surface. Authenticated users (signed in
 * through Chalyb) go to the dashboard; everyone else is sent to /login,
 * which only offers the "Continuar con Chalyb" SSO flow.
 */
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const session = await getServerSession();
  if (session) redirect("/dashboard");
  redirect("/login");
}
