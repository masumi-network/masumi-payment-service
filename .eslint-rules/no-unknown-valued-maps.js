const MESSAGE =
	'Unknown-valued map types are banned. Use a domain type, Prisma JSON types, or explicit property guards instead.';

const isUnknownType = (node) => node?.type === 'TSUnknownKeyword';

const isRecordWithUnknownValue = (node) => {
	if (node.type !== 'TSTypeReference') {
		return false;
	}

	if (node.typeName.type !== 'Identifier' || node.typeName.name !== 'Record') {
		return false;
	}

	const typeArguments = node.typeArguments?.params;
	return Array.isArray(typeArguments) && typeArguments.length === 2 && isUnknownType(typeArguments[1]);
};

const hasUnknownValueAnnotation = (node) => isUnknownType(node.typeAnnotation?.typeAnnotation);

export default {
	meta: {
		type: 'problem',
		docs: {
			description: 'Disallow unknown-valued map types in handwritten code',
		},
		messages: {
			unknownValuedMap: MESSAGE,
		},
		schema: [],
	},
	create(context) {
		return {
			TSTypeReference(node) {
				if (isRecordWithUnknownValue(node)) {
					context.report({
						node,
						messageId: 'unknownValuedMap',
					});
				}
			},
			TSIndexSignature(node) {
				if (hasUnknownValueAnnotation(node)) {
					context.report({
						node,
						messageId: 'unknownValuedMap',
					});
				}
			},
		};
	},
};
