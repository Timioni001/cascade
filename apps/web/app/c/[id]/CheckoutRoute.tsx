"use client";

import { useEffect, useState } from "react";
import { routeId } from "../../../lib/api";
import { Checkout, CheckoutSkeleton } from "./Checkout";

/** Reads the session id, embed flag and parent origin from the URL, then renders the checkout. */
export function CheckoutRoute() {
  const [route, setRoute] = useState<{ id: string; embed: boolean; parent: string | null } | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    // `parent` is the origin that embedded us; we only ever post messages to it.
    let parent: string | null = null;
    try {
      parent = q.get("parent") ? new URL(q.get("parent")!).origin : null;
    } catch {
      parent = null;
    }
    setRoute({ id: routeId(), embed: q.get("embed") === "1", parent });
  }, []);
  if (!route) return <CheckoutSkeleton />;
  return <Checkout id={route.id} embed={route.embed} parent={route.parent} />;
}
