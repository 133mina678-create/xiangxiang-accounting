import Ledger from "@/components/ledger";
export default async function Page({
  params,
}: {
  params: Promise<{ secret: string }>;
}) {
  const { secret } = await params;
  return <Ledger secret={secret} />;
}
