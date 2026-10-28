import { useEffect, useState } from "react";

// A few pages need no router library: worlds, a new world, the creator, and one world.

export type Route =
  | { page: "home" }
  | { page: "new" }
  | { page: "world"; worldId: string }
  | { page: "create"; draftId: string };

function parse(pathname: string): Route {
  const world = /^\/worlds\/([^/]+)\/?$/.exec(pathname);
  if (world) return { page: "world", worldId: decodeURIComponent(world[1]!) };
  const draft = /^\/create\/([^/]+)\/?$/.exec(pathname);
  if (draft) return { page: "create", draftId: decodeURIComponent(draft[1]!) };
  if (/^\/new\/?$/.test(pathname)) return { page: "new" };
  return { page: "home" };
}

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (options.replace) window.history.replaceState(null, "", path);
  else window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function worldPath(worldId: string): string {
  return `/worlds/${encodeURIComponent(worldId)}`;
}

export function draftPath(draftId: string, options: { assistant?: boolean } = {}): string {
  return `/create/${encodeURIComponent(draftId)}${options.assistant ? "?assistant=1" : ""}`;
}

/** A link that changes page without reloading. */
export function linkProps(path: string) {
  return {
    href: path,
    onClick: (event: { preventDefault(): void; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; button?: number }) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || (event.button ?? 0) !== 0) return;
      event.preventDefault();
      navigate(path);
    },
  };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(window.location.pathname));
  useEffect(() => {
    const update = () => setRoute((current) => {
      const next = parse(window.location.pathname);
      // A hash change (an overlay opening or closing) keeps the same page.
      return JSON.stringify(next) === JSON.stringify(current) ? current : next;
    });
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  return route;
}
