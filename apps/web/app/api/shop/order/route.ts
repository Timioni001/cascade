import { orders } from "../../../../lib/shop";

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  const o = orders.get(id);
  return o ? Response.json(o) : Response.json({ error: "no such order" }, { status: 404 });
}
