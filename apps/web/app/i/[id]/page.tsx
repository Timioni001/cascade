import { InvoicePage } from "./InvoicePage";

/** One static shell for every invoice: the id is read from the URL in the browser (/i/<id> serves /i/_). */
export function generateStaticParams() {
  return [{ id: "_" }];
}
export const dynamicParams = false;

export default function Page() {
  return <InvoicePage />;
}
