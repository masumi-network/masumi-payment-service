import { adminAuthenticatedEndpointFactory } from '@/utils/endpoint-factory/admin-authenticated';
import { z } from 'zod';
import { $Enums, APIKeyStatus, Permission } from '@prisma/client';
import { prisma } from '@/utils/db';
import { createId } from '@paralleldrive/cuid2';
import createHttpError from 'http-errors';


export const getAPIKeySchemaInput = z.object({
    limit: z.number({ coerce: true }).min(1).max(100).default(10).describe("The number of API keys to return"),
    cursorApiKey: z.string().max(550).optional().describe("Used to paginate through the API keys")
})


export const getAPIKeySchemaOutput = z.object({
    apiKeys: z.array(z.object({
        apiKey: z.string(),
        permission: z.nativeEnum(Permission),
        usageLimited: z.boolean(),
        remainingUsageCredits: z.array(z.object({
            unit: z.string(),
            amount: z.number({ coerce: true }).int().min(0)
        })),
        status: z.nativeEnum(APIKeyStatus),
    }))
});

export const queryAPIKeyEndpointGet = adminAuthenticatedEndpointFactory.build({
    method: "get",
    input: getAPIKeySchemaInput,
    output: getAPIKeySchemaOutput,
    handler: async ({ input, }) => {
        const result = await prisma.apiKey.findMany({ where: {}, cursor: input.cursorApiKey ? { apiKey: input.cursorApiKey } : undefined, take: input.limit, include: { remainingUsageCredits: true } })
        return { apiKeys: result.map((data) => { return { ...data, remainingUsageCredits: data.remainingUsageCredits.map((usageCredit) => ({ unit: usageCredit.unit, amount: parseInt(usageCredit.amount.toString()) })) } }) }
    },
});

export const addAPIKeySchemaInput = z.object({
    usageLimited: z.string().transform((s) => s.toLowerCase() == "true" ? true : false).describe("Whether the API key is usage limited. Meaning only allowed to use the specified credits or can freely spend"),
    usageCredits: z.array(z.object({
        unit: z.string().max(150),
        amount: z.number({ coerce: true }).int().min(0).max(1000000)
    })).describe("The credits allowed to be used by the API key. Only relevant if usageLimited is true. "),
    permission: z.nativeEnum(Permission).default(Permission.READ).describe("The permission of the API key"),
})

export const addAPIKeySchemaOutput = z.object({
    id: z.string(),
    apiKey: z.string(),
    permission: z.nativeEnum(Permission),
    usageLimited: z.boolean(),
    status: z.nativeEnum(APIKeyStatus),
})

export const addAPIKeyEndpointPost = adminAuthenticatedEndpointFactory.build({
    method: "post",
    input: addAPIKeySchemaInput,
    output: addAPIKeySchemaOutput,
    handler: async ({ input }) => {
        const apiKey = ("masumi-registry-" + input.permission == $Enums.Permission.ADMIN ? "admin-" : "") + createId()
        const result = await prisma.apiKey.create({
            data: {
                apiKey: apiKey, status: $Enums.APIKeyStatus.ACTIVE, permission: input.permission, usageLimited: input.usageLimited, remainingUsageCredits: {
                    createMany: { data: input.usageCredits.map((usageCredit) => ({ unit: usageCredit.unit, amount: usageCredit.amount })) }
                }
            }
        })
        return result
    },
});

export const updateAPIKeySchemaInput = z.object({
    id: z.string().max(150).optional().describe("The id of the API key to update. Provide either id or apiKey"),
    apiKey: z.string().max(550).optional().describe("The API key to update. Provide either id or apiKey"),
    usageCredits: z.array(z.object({
        unit: z.string().max(150),
        amount: z.number({ coerce: true }).int().min(0).max(1000000)
    })).optional().describe("The remaining credits allowed to be used by the API key. Only relevant if usageLimited is true. "),
    status: z.nativeEnum(APIKeyStatus).default(APIKeyStatus.ACTIVE).optional().describe("The status of the API key"),
})

export const updateAPIKeySchemaOutput = z.object({
    id: z.string(),
    apiKey: z.string(),
    permission: z.nativeEnum(Permission),
    usageLimited: z.boolean(),
    status: z.nativeEnum(APIKeyStatus),
})

export const updateAPIKeyEndpointPatch = adminAuthenticatedEndpointFactory.build({
    method: "patch",
    input: updateAPIKeySchemaInput,
    output: updateAPIKeySchemaOutput,
    handler: async ({ input, }) => {

        if (input.id) {
            const result = await prisma.apiKey.update({ where: { id: input.id }, data: { usageLimited: input.usageLimited, status: input.status, remainingUsageCredits: { set: input.usageCredits?.map((usageCredit) => ({ id: createId(), unit: usageCredit.unit, amount: usageCredit.amount })) } } })
            return result
        } else if (input.apiKey) {
            const result = await prisma.apiKey.update({ where: { apiKey: input.apiKey }, data: { usageLimited: input.usageLimited, status: input.status, remainingUsageCredits: { set: input.usageCredits?.map((usageCredit) => ({ id: createId(), unit: usageCredit.unit, amount: usageCredit.amount })) } } })
            return result;
        }
        throw createHttpError(400, "Invalid input")
    },
});

export const deleteAPIKeySchemaInput = z.object({
    id: z.string().max(150).optional().describe("The id of the API key to delete. Provide either id or apiKey"),
    apiKey: z.string().max(550).optional().describe("The API key to delete. Provide either id or apiKey"),
})

export const deleteAPIKeySchemaOutput = z.object({
    id: z.string(),
    apiKey: z.string(),
});

export const deleteAPIKeyEndpointDelete = adminAuthenticatedEndpointFactory.build({
    method: "delete",
    input: deleteAPIKeySchemaInput,
    output: deleteAPIKeySchemaOutput,

    handler: async ({ input, }) => {
        if (input.id) {
            const result = await prisma.apiKey.delete({ where: { id: input.id } })
            return result
        } else if (input.apiKey) {
            const result = await prisma.apiKey.delete({ where: { apiKey: input.apiKey } })
            return result
        }
        throw createHttpError(400, "Invalid input")
    },
});
