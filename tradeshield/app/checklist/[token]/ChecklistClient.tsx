"use client";


import {
  useMemo,
  useState
} from "react";

import styles
  from "./checklist.module.css";


type ChecklistItem = {
  key: string;
  label: string;
  checked: boolean;
};


export default function ChecklistClient({
  token,
  initialItems
}: {
  token: string;
  initialItems: ChecklistItem[];
}) {
  const [
    items,
    setItems
  ] =
    useState(
      initialItems
    );


  const [
    savingKey,
    setSavingKey
  ] =
    useState<
      string | null
    >(
      null
    );


  const [
    status,
    setStatus
  ] =
    useState(
      "Saved"
    );


  const completed =
    useMemo(
      () =>
        items.filter(
          item =>
            item.checked
        ).length,

      [
        items
      ]
    );


  async function toggleItem(
    itemKey: string
  ) {
    const existingItem =
      items.find(
        item =>
          item.key ===
          itemKey
      );


    if (!existingItem) {
      return;
    }


    const newChecked =
      !existingItem.checked;


    /*
      Update UI immediately.
    */
    setItems(
      current =>
        current.map(
          item =>
            item.key ===
            itemKey
              ? {
                  ...item,
                  checked:
                    newChecked
                }
              : item
        )
    );


    setSavingKey(
      itemKey
    );

    setStatus(
      "Saving..."
    );


    try {
      const response =
        await fetch(
          `/api/checklists/${encodeURIComponent(
            token
          )}`,
          {
            method:
              "PATCH",

            headers: {
              "Content-Type":
                "application/json"
            },

            body:
              JSON.stringify({
                itemKey,

                checked:
                  newChecked
              })
          }
        );


      const data =
        await response.json();


      if (
        !response.ok ||
        data.ok !== true
      ) {
        throw new Error(
          data.error ||
          "Could not save checklist."
        );
      }


      setStatus(
        "Saved"
      );


    } catch (error) {
      /*
        Saving failed.

        Reverse the optimistic UI update.
      */
      setItems(
        current =>
          current.map(
            item =>
              item.key ===
              itemKey
                ? {
                    ...item,
                    checked:
                      !newChecked
                  }
                : item
          )
      );


      setStatus(
        error instanceof Error
          ? error.message
          : "Save failed"
      );


    } finally {
      setSavingKey(
        null
      );
    }
  }


  return (
    <>
      <div
        className={
          styles.progressHeader
        }
      >
        <span>
          Progress
        </span>

        <strong>
          {completed}/{items.length}
        </strong>
      </div>


      <div
        className={
          styles.progressTrack
        }
      >
        <div
          className={
            styles.progressFill
          }
          style={{
            width:
              items.length
                ? `${
                    (
                      completed /
                      items.length
                    ) * 100
                  }%`
                : "0%"
          }}
        />
      </div>


      <div
        className={
          styles.checklist
        }
      >
        {
          items.map(
            item => (
              <button
                key={
                  item.key
                }
                type="button"
                disabled={
                  savingKey ===
                  item.key
                }
                onClick={
                  () =>
                    toggleItem(
                      item.key
                    )
                }
                className={
                  `${
                    styles.checkItem
                  } ${
                    item.checked
                      ? styles.checked
                      : ""
                  }`
                }
              >
                <span
                  className={
                    styles.checkbox
                  }
                >
                  {
                    item.checked
                      ? "✓"
                      : ""
                  }
                </span>

                <span>
                  {
                    item.label
                  }
                </span>
              </button>
            )
          )
        }
      </div>


      <div
        className={
          styles.status
        }
      >
        {status}
      </div>
    </>
  );
}