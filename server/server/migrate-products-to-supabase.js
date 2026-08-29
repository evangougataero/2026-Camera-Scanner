import "dotenv/config";
import Database from "better-sqlite3";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = String(
  process.env.SUPABASE_URL || ""
).trim();

const SUPABASE_SECRET_KEY = String(
  process.env.SUPABASE_SECRET_KEY || ""
).trim();

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  throw new Error(
    "Missing SUPABASE_URL or SUPABASE_SECRET_KEY in .env"
  );
}

const supabase =
  createClient(
    SUPABASE_URL,
    SUPABASE_SECRET_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    }
  );

// CHANGE THIS if your DB has a different name/path.
const DB_PATH = "./camera-products.db";

const db =
  new Database(
    DB_PATH,
    {
      readonly: true
    }
  );

const rows =
  db.prepare(`
    SELECT
      canonical_name,
      brand,
      model,
      product_type,
      estimated_resale_price
    FROM products
  `).all();

console.log(
  `Found ${rows.length} local products.`
);

const BATCH_SIZE = 500;

for (
  let i = 0;
  i < rows.length;
  i += BATCH_SIZE
) {
  const batch =
    rows
      .slice(
        i,
        i + BATCH_SIZE
      )
      .map(row => ({
        canonical_name:
          row.canonical_name,

        brand:
          row.brand || "",

        model:
          row.model || "",

        product_type:
          row.product_type || "",

        estimated_resale_price:
          Number(
            row.estimated_resale_price
          ),

        updated_at:
          new Date()
            .toISOString()
      }));

  const {
    error
  } =
    await supabase
      .from(
        "camera_products"
      )
      .upsert(
        batch,
        {
          onConflict:
            "canonical_name"
        }
      );

  if (error) {
    console.error(
      `Batch ${i}-${
        Math.min(
          i + BATCH_SIZE,
          rows.length
        )
      } failed:`,
      error
    );

    process.exit(1);
  }

  console.log(
    `Uploaded ${
      Math.min(
        i + BATCH_SIZE,
        rows.length
      )
    } / ${rows.length}`
  );
}

db.close();

console.log(
  "Migration complete."
);