import { z } from 'zod';

import { ExtendedTRPCError } from '@/server/config/errors';
import { createTRPCRouter, publicProcedure } from '@/server/config/trpc';

export type Task = {
  id: string;
  name: string;
  icon: string;
  isDone: boolean;
  isUrgent: boolean;
  comment: string;
  createdAt: number;
  updatedAt: number;
};

const zTask = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string(),
  is_done: z.boolean(),
  is_urgent: z.boolean().optional(),
  comment: z.string().optional(),
  created_at: z.number(),
  updated_at: z.number(),
});

export const zDatabaseChanges = z.object({
  tasks: z.object({
    created: z.array(zTask).optional(),
    updated: z.array(zTask).optional(),
    deleted: z.array(z.string()).optional(),
  }),
});

export const syncRouter = createTRPCRouter({
  pushChanges: publicProcedure()
    .meta({
      openapi: {
        method: 'POST',
        path: '/sync/push',
        protect: false,
        tags: ['sync-push'],
      },
    })
    .input(
      z.object({
        changes: zDatabaseChanges,
        lastPulledAt: z.number().nullable(),
      })
    )
    .output(z.void())
    .mutation(async ({ ctx, input }) => {
      try {
        await ctx.db.$transaction(async (tx) => {
          const createdTasks = [];
          const updatedTasks = [];

          const now = Date.now();

          if (
            input.changes?.tasks?.created &&
            input.changes?.tasks?.created?.length > 0
          ) {
            for (const createdTask of input.changes?.tasks?.created) {
              const existingTask = await tx.task.findUnique({
                where: {
                  id: createdTask.id,
                },
              });

              if (existingTask) {
                ctx.logger.warn(
                  '⚠️ Task creation converted in update to not break ! : '
                );
                updatedTasks.push({
                  id: createdTask.id,
                  name: createdTask.name,
                  icon: createdTask.icon,
                  isDone: createdTask.is_done,
                  ...(createdTask.is_urgent !== undefined
                    ? { isUrgent: createdTask.is_urgent }
                    : {}),
                  ...(createdTask.comment !== undefined
                    ? { comment: createdTask.comment }
                    : {}),
                  updatedAt: createdTask.updated_at,
                });
              } else {
                createdTasks.push({
                  id: createdTask.id,
                  name: createdTask.name,
                  icon: createdTask.icon,
                  isDone: createdTask.is_done,
                  isUrgent: createdTask.is_urgent,
                  comment: createdTask.comment,
                  createdAt: createdTask.created_at,
                  updatedAt: createdTask.updated_at,
                  serverCreatedAt: now,
                  serverUpdatedAt: now,
                });
              }
            }
          }

          await tx.task.createMany({
            data: createdTasks,
          });

          if (
            input.changes?.tasks?.updated &&
            input.changes?.tasks?.updated.length > 0
          ) {
            for (const updatedTask of input.changes?.tasks?.updated) {
              updatedTasks.push({
                id: updatedTask.id,
                name: updatedTask.name,
                icon: updatedTask.icon,
                isDone: updatedTask.is_done,
                ...(updatedTask.is_urgent !== undefined
                  ? { isUrgent: updatedTask.is_urgent }
                  : {}),
                ...(updatedTask.comment !== undefined
                  ? { comment: updatedTask.comment }
                  : {}),
                updatedAt: updatedTask.updated_at,
              });
            }
          }

          const updateQueries = updatedTasks.map(async (task) => {
            await tx.task.update({
              data: {
                ...task,
                serverUpdatedAt: now,
              },
              where: {
                id: task?.id,
              },
            });
          });
          await Promise.all(updateQueries);
        });
      } catch (e) {
        throw new ExtendedTRPCError({
          cause: e,
        });
      }
    }),

  pullChanges: publicProcedure()
    .meta({
      openapi: {
        method: 'POST',
        path: '/sync/pull',
        protect: false,
        tags: ['sync-pull'],
      },
    })
    .input(
      z.object({
        lastPulledAt: z.number().nullable(),
        schemaVersion: z.number(),
        migration: z.string().nullable(),
      })
    )
    .output(
      z.object({
        changes: zDatabaseChanges,
        timestamp: z.number(),
      })
    )
    .query(async ({ ctx, input }) => {
      let safeLastPulledAt = 1;
      if (!!input.lastPulledAt) {
        safeLastPulledAt = input.lastPulledAt;
      }

      const createdTasks = await ctx.db.task.findMany({
        where: {
          serverCreatedAt: {
            gt: safeLastPulledAt,
          },
        },
      });

      let updatedTasks = await ctx.db.task.findMany({
        where: {
          AND: [
            {
              serverUpdatedAt: {
                gt: safeLastPulledAt,
              },
            },
            {
              serverCreatedAt: {
                lte: safeLastPulledAt,
              },
            },
          ],
        },
      });

      if (input?.schemaVersion >= 2 && input?.migration) {
        const migration = JSON.parse(input?.migration);
        if (migration?.from < 2) {
          updatedTasks = await ctx.db.task.findMany();
        }
      }

      return {
        timestamp: Date.now(),
        changes: {
          tasks: {
            created: createdTasks?.map((task) => ({
              id: task.id,
              name: task.name,
              icon: task.icon,
              is_done: task.isDone,
              is_urgent: task.isUrgent,
              comment: task.comment,
              created_at: Number(task.createdAt),
              updated_at: Number(task.updatedAt),
            })),
            updated: updatedTasks?.map((task) => ({
              id: task.id,
              name: task.name,
              icon: task.icon,
              is_done: task.isDone,
              is_urgent: task.isUrgent,
              comment: task.comment,
              created_at: Number(task.createdAt),
              updated_at: Number(task.updatedAt),
            })),
            deleted: [],
          },
        },
      };
    }),
});
