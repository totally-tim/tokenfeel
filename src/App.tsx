import { useEffect, useMemo, useState } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { TopNav } from "./components/TopNav";
import { loadStaticCatalog, type StaticCatalog } from "./data/staticCatalog";
import { ConfigsPage } from "./pages/ConfigsPage";
import { ContributePage } from "./pages/ContributePage";
import { LandingPage } from "./pages/LandingPage";
import { MethodPage } from "./pages/MethodPage";
import { PlaygroundPage } from "./pages/PlaygroundPage";
import { RacePage } from "./pages/RacePage";
import { buildPageHash, pageFromHashValue, type PageId } from "./lib/routing";

// Single source of truth for hash-based routing: this is the only
// `hashchange` listener in the app. It tracks the raw hash string; the
// current page and any page-specific hash state (e.g. RacePage's share
// params) are derived from it, rather than each consumer listening
// independently.
export default function App() {
  const [hash, setHash] = useState<string>(() => window.location.hash);
  const [catalog, setCatalog] = useState<StaticCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const page = useMemo(() => pageFromHashValue(hash), [hash]);

  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [page]);

  useEffect(() => {
    let alive = true;
    loadStaticCatalog()
      .then((loadedCatalog) => {
        if (alive) setCatalog(loadedCatalog);
      })
      .catch((error: unknown) => {
        if (alive) setCatalogError(error instanceof Error ? error.message : "Failed to load catalog");
      });
    return () => {
      alive = false;
    };
  }, []);

  const navigate = (next: PageId) => {
    const nextHash = buildPageHash(next);
    window.location.hash = nextHash;
    setHash(nextHash);
  };

  const content = useMemo(() => {
    if (catalogError) {
      return (
        <main className="boot-screen error">
          <span>CATALOG ERROR</span>
          <h1>Static benchmark catalog did not load.</h1>
          <p>{catalogError}</p>
        </main>
      );
    }

    if (!catalog) {
      return (
        <main className="boot-screen">
          <span>LOADING CATALOG</span>
          <h1>Preparing benchmark workbench.</h1>
          <p>Fetching the static catalog index outside the JavaScript bundle.</p>
        </main>
      );
    }

    switch (page) {
      case "playground":
        return <PlaygroundPage catalog={catalog} />;
      case "race":
        return <RacePage catalog={catalog} onNavigate={navigate} hash={hash} />;
      case "configs":
        return <ConfigsPage catalog={catalog} />;
      case "method":
        return <MethodPage />;
      case "contribute":
        return <ContributePage />;
      case "landing":
      default:
        return <LandingPage catalog={catalog} onNavigate={navigate} />;
    }
  }, [catalog, catalogError, page, hash]);

  return (
    <div className="app-shell">
      <TopNav page={page} onNavigate={navigate} />
      <ErrorBoundary key={page}>{content}</ErrorBoundary>
    </div>
  );
}
