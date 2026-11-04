import { CheckoutRoute } from "./CheckoutRoute";

/** One static shell for every checkout: the session id is read from the URL in the browser (/c/<id> serves /c/_). */
export function generateStaticParams() {
  return [{ id: "_" }];
}
export const dynamicParams = false;

export default function Page() {
  return <CheckoutRoute />;
}
