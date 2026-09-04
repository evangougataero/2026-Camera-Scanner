import { createClient } from "@supabase/supabase-js";
import { randomBytes, randomInt } from "crypto";

export async function POST(request: Request) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;

    if (!supabaseUrl) {
      return Response.json(
        { error: "NEXT_PUBLIC_SUPABASE_URL is missing from .env.local" },
        { status: 500 }
      );
    }

    if (!supabaseSecretKey) {
      return Response.json(
        { error: "SUPABASE_SECRET_KEY is missing from .env.local" },
        { status: 500 }
      );
    }

    const supabase = createClient(
      supabaseUrl,
      supabaseSecretKey,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      }
    );

    const body = await request.json();

const {
  item_name,
  item_price,
  listing_url,
} = body;

    if (!item_name || item_price === undefined || item_price === "") {
      return Response.json(
        { error: "Item name and price are required." },
        { status: 400 }
      );
    }

    const price = Number(item_price);

    if (!Number.isFinite(price) || price <= 0) {
      return Response.json(
        { error: "Enter a valid purchase price." },
        { status: 400 }
      );
    }

    const public_token = randomBytes(16).toString("hex");

    const verification_code =
      "TS-" + randomInt(10000, 100000).toString();

    const { data, error } = await supabase
      .from("transactions")
      .insert({
        public_token,
        item_name,
        item_price: price,
        listing_url: listing_url || null,
        verification_code,
        seller_confirmed: false,
        verification_status: "pending",
        shipping_status: "pending",
      })
      .select()
      .single();

    if (error) {
      console.error("Supabase insert error:", error);

      return Response.json(
        {
          error: "Supabase error: " + error.message,
        },
        { status: 500 }
      );
    }

    return Response.json({
      success: true,
      transaction: data,
      verificationUrl: `/verify/${public_token}`,
    });
  } catch (error) {
    console.error("API route error:", error);

    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unknown server error.",
      },
      { status: 500 }
    );
  }
}