import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const res = await fetch("https://prestocks.com/api/prestocks", {
      headers: {
        Accept: "application/json",
        "User-Agent": "PreStocksLend/1.0",
      },
      cache: "no-store",
    });

    if (!res.ok) {
      console.error("Upstream PreStocks API status:", res.status);
      return NextResponse.json(
        { error: "Failed to fetch PreStocks data", status: res.status },
        { status: 502 }
      );
    }

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      const text = await res.text();
      console.error("Non-JSON response from PreStocks:", text.slice(0, 200));
      return NextResponse.json(
        { error: "Upstream returned non-JSON" },
        { status: 502 }
      );
    }

    const data = await res.json();

    // Ensure we always return an array
    if (!Array.isArray(data)) {
      return NextResponse.json(
        { error: "Unexpected data shape" },
        { status: 502 }
      );
    }

    return NextResponse.json(data);
  } catch (error: any) {
    console.error("PreStocks API proxy error:", error?.message || error);
    return NextResponse.json(
      { error: "Internal server error", message: error?.message },
      { status: 500 }
    );
  }
}
