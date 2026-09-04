import {
  notFound
} from "next/navigation";

import {
  getDealChecklistByToken
} from "@/lib/deal-checklist";

import ChecklistClient
  from "./ChecklistClient";

import styles
  from "./checklist.module.css";


export const dynamic =
  "force-dynamic";


export default async function ChecklistPage({
  params
}: {
  params:
    Promise<{
      token: string;
    }>;
}) {
  const {
    token
  } =
    await params;


  const checklist =
    await getDealChecklistByToken(
      token
    );


  if (!checklist) {
    notFound();
  }


  return (
    <main
      className={
        styles.page
      }
    >
      <section
        className={
          styles.card
        }
      >
        <div
          className={
            styles.header
          }
        >
          <div
            className={
              styles.eyebrow
            }
          >
            PURCHASE CHECKLIST
          </div>

          <h1>
            {
              checklist.title ||
              "Marketplace Listing"
            }
          </h1>

          <p
            className={
              styles.subtitle
            }
          >
            Complete these checks before
            purchasing the listing.
          </p>
        </div>


        {
          checklist.listingUrl
            ? (
              <a
                href={
                  checklist.listingUrl
                }
                target="_blank"
                rel="noopener noreferrer"
                className={
                  styles.listingButton
                }
              >
                Open Marketplace Listing
              </a>
            )
            : null
        }


        <ChecklistClient
          token={
            checklist.token
          }
          initialItems={
            checklist.items
          }
        />
      </section>
    </main>
  );
}