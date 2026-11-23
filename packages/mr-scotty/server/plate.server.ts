import config from '@plone/registry';

/**
 * Converting classic Volto blocks to Aurora's document model, where a page's
 * body is one Plate document in the `main` region of its `blocks` field.
 *
 * Aurora converts content when it reads it, with conversion functions it
 * registers as utilities. Mr. Scotty runs inside Aurora, so it calls the same
 * utilities, including those other add-ons register, and writes the result.
 * See Aurora's `apps/aurora/app/config/server/content-migrations.server.ts`,
 * which this follows.
 */

/** The `blocks` key of the region that holds the page body. */
export const MAIN_REGION = 'main';
/** The `@type` of a region whose `value` is a Plate document. */
export const PLATE_TYPE = 'plate';
/** Where the page body was stored before it became the `main` region. */
const SOMERSAULT_KEY = '__somersault__';

type Node = Record<string, unknown>;
type Payload = Record<string, unknown>;

export interface PlateConversion {
  payload: Payload;
  /**
   * The `@type`s of blocks no conversion function handled. Aurora drops them
   * too when it reads the page.
   */
  droppedBlocks: string[];
}

/** Converts a content payload; injected into the planner. */
export type PlateConverter = (payload: Payload) => PlateConversion;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function utilities(type: string) {
  if (typeof config.getUtilities !== 'function') return [];
  return config.getUtilities({ type }) as Array<{
    method: (args: Record<string, unknown>) => unknown;
  }>;
}

/** Whether this Aurora server can convert blocks at all. */
export function canConvertToPlate(): boolean {
  return utilities('somersaultBlockMigration').length > 0;
}

/**
 * Returns `payload` with its body as a Plate document in the `main` region.
 * A payload that already has one, or the older `__somersault__` block, keeps
 * it. A payload without blocks is returned as it is.
 */
export const convertToPlate: PlateConverter = (source) => {
  const payload = structuredClone(source);
  const droppedBlocks: string[] = [];
  const blocks = isRecord(payload.blocks) ? payload.blocks : undefined;
  if (!blocks) return { payload, droppedBlocks };

  // Content stored in an older Plate shape: let the content migrations, such
  // as the `__somersault__` rename, bring it up to date.
  for (const utility of utilities('contentMigration')) {
    utility.method({ content: payload });
  }

  const existing = (payload.blocks as Payload)[MAIN_REGION];
  if (isRecord(existing) && existing['@type'] === PLATE_TYPE) {
    // Already a Plate page: write only the region, as Aurora's editor does.
    payload.blocks = { [MAIN_REGION]: existing };
    payload.blocks_layout = { items: [] };
    return { payload, droppedBlocks };
  }

  const layout = isRecord(payload.blocks_layout)
    ? payload.blocks_layout.items
    : undefined;
  if (!Array.isArray(layout)) return { payload, droppedBlocks };

  const blockMigrations = utilities('somersaultBlockMigration');
  let value: Node[] = layout.flatMap((blockId) => {
    // The legacy region, when some content lists it, is not a block.
    if (typeof blockId !== 'string' || blockId === SOMERSAULT_KEY) return [];
    const block = blocks[blockId];
    if (!isRecord(block)) return [];
    const nodes = blockMigrations.flatMap(
      (utility) =>
        (utility.method({ block, blockId, content: payload }) as Node[]) ?? [],
    );
    if (nodes.length === 0) {
      droppedBlocks.push(
        typeof block['@type'] === 'string' ? block['@type'] : 'unknown',
      );
    }
    return nodes;
  });

  for (const utility of utilities('somersaultMigration')) {
    value = utility.method({ content: payload, value }) as Node[];
  }

  // A page starts with exactly one title node, kept in sync with the title
  // field. Classic pages without a title block get one.
  if (!value.some((node) => node.type === 'title')) {
    value = [
      {
        type: 'title',
        children: [
          { text: typeof payload.title === 'string' ? payload.title : '' },
        ],
      },
      ...value,
    ];
  }

  payload.blocks = { [MAIN_REGION]: { '@type': PLATE_TYPE, value } };
  payload.blocks_layout = { items: [] };
  return { payload, droppedBlocks: [...new Set(droppedBlocks)] };
};
