import { createClient } from "@supabase/supabase-js";


const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL;


const supabaseSecretKey =
  process.env.SUPABASE_SECRET_KEY;


if (!supabaseUrl) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL"
  );
}


if (!supabaseSecretKey) {
  throw new Error(
    "Missing SUPABASE_SECRET_KEY"
  );
}


/*
  Server-side Supabase client.

  IMPORTANT:
  SUPABASE_SECRET_KEY stays on the Vercel server.
  It is NEVER sent to the checklist browser page.
*/
const supabaseAdmin =
  createClient(
    supabaseUrl,
    supabaseSecretKey,
    {
      auth: {
        persistSession:
          false,

        autoRefreshToken:
          false,

        detectSessionInUrl:
          false
      }
    }
  );


/*
  ============================================================
  PURCHASE CHECKLIST ITEMS
  ============================================================

  This is where you edit the checklist in the future.

  key:
    Keep permanent once you start using it.

  label:
    Can be changed whenever you want.

  enabled:
    true  = show
    false = hide
*/

export const DEAL_CHECKLIST_ITEMS = [
  {
    key:
      "everything_functional",

    label:
      "Everything functional",

    enabled:
      true
  },

  {
    key:
      "seller_profile_ok",

    label:
      "Nothing sketchy about seller profile / reviews",

    enabled:
      true
  },

  {
    key:
      "analysis_verified",

    label:
      "Product analysis is correct",

    enabled:
      true
  },

  {
    key:
      "tradeshield_confirmation_sent",

    label:
      "TradeShield confirmation sent",

    enabled:
      true
  },

  {
    key:
      "manual_estimate_complete",

    label:
      "Listing manually estimated",

    enabled:
      true
  }
] as const;


export async function getDealChecklistByToken(
  rawToken: string
) {
  const token =
    String(
      rawToken || ""
    ).trim();


  if (!token) {
    return null;
  }


  /*
    Get the checklist/listing.
  */
  const {
    data:
      checklist,

    error:
      checklistError
  } =
    await supabaseAdmin
      .from(
        "deal_checklists"
      )
      .select(`
        id,
        token,
        source_key,
        analysis_run_id,
        listing_id,
        listing_url,
        title,
        created_at,
        updated_at
      `)
      .eq(
        "token",
        token
      )
      .maybeSingle();


  if (checklistError) {
    throw checklistError;
  }


  if (!checklist) {
    return null;
  }


  /*
    Load all saved checkbox states.
  */
  const {
    data:
      savedStates,

    error:
      stateError
  } =
    await supabaseAdmin
      .from(
        "deal_checklist_states"
      )
      .select(
        "item_key, checked"
      )
      .eq(
        "checklist_id",
        checklist.id
      );


  if (stateError) {
    throw stateError;
  }


  const stateMap =
    new Map(
      (
        savedStates || []
      ).map(
        row => [
          row.item_key,
          row.checked === true
        ]
      )
    );


  const items =
    DEAL_CHECKLIST_ITEMS
      .filter(
        item =>
          item.enabled !==
          false
      )
      .map(
        item => ({
          key:
            item.key,

          label:
            item.label,

          checked:
            stateMap.get(
              item.key
            ) === true
        })
      );


  return {
    id:
      checklist.id,

    token:
      checklist.token,

    listingId:
      checklist.listing_id,

    listingUrl:
      checklist.listing_url,

    title:
      checklist.title,

    createdAt:
      checklist.created_at,

    items
  };
}


export async function saveDealChecklistItem({
  token,
  itemKey,
  checked
}: {
  token: string;
  itemKey: string;
  checked: boolean;
}) {
  /*
    Only allow checklist items actually defined
    by this application.
  */
  const validItem =
    DEAL_CHECKLIST_ITEMS.find(
      item =>
        item.key ===
        itemKey
    );


  if (!validItem) {
    throw new Error(
      "Unknown checklist item."
    );
  }


  const {
    data:
      checklist,

    error:
      checklistError
  } =
    await supabaseAdmin
      .from(
        "deal_checklists"
      )
      .select(
        "id"
      )
      .eq(
        "token",
        token
      )
      .maybeSingle();


  if (checklistError) {
    throw checklistError;
  }


  if (!checklist) {
    throw new Error(
      "Checklist not found."
    );
  }


  const {
    error:
      saveError
  } =
    await supabaseAdmin
      .from(
        "deal_checklist_states"
      )
      .upsert(
        {
          checklist_id:
            checklist.id,

          item_key:
            itemKey,

          checked,

          updated_at:
            new Date()
              .toISOString()
        },
        {
          onConflict:
            "checklist_id,item_key"
        }
      );


  if (saveError) {
    throw saveError;
  }


  return {
    itemKey,
    checked
  };
}