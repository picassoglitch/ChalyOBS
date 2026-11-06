import Link from "next/link";
import { SettingsIcon } from "./icons";

export function Footer() {
  return (
    <footer className="flex items-center justify-between px-6 py-3 border-t border-border text-text-tertiary text-xs">
      <Link
        href="/settings"
        className="flex items-center gap-1.5 hover:text-text-primary transition"
      >
        <SettingsIcon className="w-3.5 h-3.5" />
        Ajustes
      </Link>
      <Link
        href="/analytics"
        className="hover:text-text-primary transition"
      >
        Estadísticas
      </Link>
    </footer>
  );
}
