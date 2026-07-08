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

function pageFromHash(): PageId {
  return pageFromHashValue(window.location.hash);
}

export default function App() {
  const [page, setPage] = useState<PageId>(() => pageFromHash());
  const [catalog, setCatalog] = useState<StaticCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
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
    window.location.hash = buildPageHash(next);
    setPage(next);
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
        return <RacePage catalog={catalog} onNavigate={navigate} />;
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
  }, [catalog, catalogError, page]);

  return (
    <div className="app-shell">
      <TopNav page={page} onNavigate={navigate} />
      <ErrorBoundary key={page}>{content}</ErrorBoundary>
    </div>
  );
}
