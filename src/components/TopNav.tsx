import { Github } from "lucide-react";
import { buildPageHash, type PageId } from "../lib/routing";
import { GITHUB_REPO_URL } from "../lib/projectLinks";

interface TopNavProps {
  page: PageId;
  onNavigate: (page: PageId) => void;
}

const navItems: Array<{ id: PageId; label: string }> = [
  { id: "playground", label: "Playground" },
  { id: "race", label: "Race" },
  { id: "configs", label: "Configs" },
  { id: "method", label: "Data & method" },
  { id: "contribute", label: "Contribute" }
];

export function TopNav({ page, onNavigate }: TopNavProps) {
  return (
    <header className="top-nav">
      <button className="brand" type="button" onClick={() => onNavigate("landing")}>
        <span className="brand-mark">tf</span>
        <span className="brand-word">Tokenfeel</span>
        <span className="brand-tag">v1 · beta</span>
      </button>

      <nav className="nav-links" aria-label="Primary">
        {navItems.map((item) => (
          <a
            key={item.id}
            href={buildPageHash(item.id)}
            className={page === item.id ? "active" : ""}
            aria-current={page === item.id ? "page" : undefined}
            onClick={(event) => {
              event.preventDefault();
              onNavigate(item.id);
            }}
          >
            {item.label}
          </a>
        ))}
      </nav>

      <div className="nav-actions">
        <a href={GITHUB_REPO_URL} className="github-link" target="_blank" rel="noreferrer">
          GitHub <Github size={13} />
        </a>
        {page !== "race" && (
          <button type="button" className="primary-button nav-button" onClick={() => onNavigate("race")}>
            Start a race
          </button>
        )}
      </div>
    </header>
  );
}
