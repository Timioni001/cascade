import { Receipt } from "./Receipt";

/** One static shell for every receipt: the id is read from the URL in the browser (/r/<id> serves /r/_). */
export function generateStaticParams() {
  return [{ id: "_" }];
}
export const dynamicParams = false;

export default function Page() {
  return <Receipt />;
}
