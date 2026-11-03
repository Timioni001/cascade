import { Checkout } from "./Checkout";

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const q = await searchParams;
  // `parent` is the origin that embedded us; we only ever post messages to it.
  let parent: string | null = null;
  try {
    parent = q.parent ? new URL(q.parent).origin : null;
  } catch {
    parent = null;
  }
  return <Checkout id={id} embed={q.embed === "1"} parent={parent} />;
}
