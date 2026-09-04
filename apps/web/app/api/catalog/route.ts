import { NextResponse } from "next/server";
import { buildPublicCatalog } from "@/lib/catalog-public";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(buildPublicCatalog());
}
