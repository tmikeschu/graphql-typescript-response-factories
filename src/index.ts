import { PluginFunction, Types } from "@graphql-codegen/plugin-helpers";
import {
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLOutputType,
  GraphQLSchema,
  OperationDefinitionNode,
  isUnionType,
  isScalarType,
} from "graphql";
import { Code, code } from "ts-poet";
import PluginOutput = Types.PluginOutput;

/** Generates `newQueryResponse({ ... })` factory functions in our `graphql-types` codegen output. */
export const plugin: PluginFunction = async (schema, documents) => {
  const factories: Code[] = [];
  documents.forEach((d) => {
    if (d.document) {
      d.document.definitions.forEach((d) => {
        if (d.kind === "OperationDefinition" && d.name && d.operation !== "subscription") {
          factories.push(newOperationFactory(schema, d));
        }
      });
    }
  });
  const content = (await code`${factories}`.toStringWithImports()) + mockedResponse;
  return { content } as PluginOutput;
};

function newOperationFactory(schema: GraphQLSchema, def: OperationDefinitionNode): Code {
  const defName = def.name?.value;
  const hasVariables = (def.variableDefinitions?.length || 0) > 0;
  const operation = `${def.operation.charAt(0).toUpperCase()}${def.operation.slice(1)}`;
  const rootType = operation === "Query" ? schema.getQueryType() : schema.getMutationType();

  return code`
    interface ${defName}DataOptions {
        ${def.selectionSet.selections.map((s) => {
          if (s.kind === "Field") {
            const name = s.name.value;
            const field = rootType?.getFields()[name];
            if (field) {
              let type = maybeDenull(field.type);
              let isList = false;
              if (type instanceof GraphQLList) {
                type = maybeDenull(type.ofType);
                isList = true;
              }
              const asList = isList ? "[]" : "";

              if (isUnionType(type)) {
                if (isList) {
                  return type
                    .getTypes()
                    .map((t) => {
                      const orNull = t instanceof GraphQLNonNull ? "" : " | null";
                      return `${t.name}: ${t.name}Options${asList}${orNull}`;
                    })
                    .join("\n");
                }
                const union = type
                  .getTypes()
                  .map((t) => {
                    const orNull = t instanceof GraphQLNonNull ? "" : " | null";
                    return `{ type: "${t.name}", value: ${t.name}Options${asList}${orNull} }`;
                  })
                  .join("|");
                return `union: ${union}`;
              } else if (isScalarType(type)) {
                const orNull = field.type instanceof GraphQLNonNull ? "" : " | null";
                return `${name}?: Scalars["${type.name}"]${asList}${orNull};`;
              } else {
                const orNull = field.type instanceof GraphQLNonNull ? "" : " | null";
                return `${name}?: ${(type as GraphQLObjectType).name}Options${asList}${orNull};`;
              }
            }
          }
        })}
    }

    export function new${defName}Data(data: ${defName}DataOptions) {
      return {
        __typename: "${operation}" as const,
        ${def.selectionSet.selections.map((s) => {
          // This is the top-level Mutation/Query result, so usually/basically always has a single
          // field like `saveAuthor: AuthorResult!` where we can use the existing `newAuthorResult` factory.
          if (s.kind === "Field") {
            const name = s.name.value;
            const field = rootType?.getFields()[name];
            if (field) {
              let type = maybeDenull(field.type);
              if (type instanceof GraphQLList) {
                type = maybeDenull(type.ofType);
                if (isUnionType(type)) {
                  const types = type
                    .getTypes()
                    .reduce(
                      (acc, t) => {
                        const map = `(data["${t.name}"]?.map(d => new${t.name}(d)) || [])`;
                        return `${acc}.concat(${map})`;
                      },
                      `([] as Array<${type
                        .getTypes()
                        .map((t) => t.name)
                        .join(" | ")}>)`,
                    )
                    .replace(/.concat\($/, "");
                  return `${name}: ${types}`;
                } else {
                  return `${name}: data["${name}"]?.map(d => new${(type as GraphQLObjectType).name}(d)) || [],`;
                }
              }
              if (isUnionType(type)) {
                const types = type
                  .getTypes()
                  .map((t) => {
                    const orNull = t instanceof GraphQLNonNull ? "" : "OrNull";
                    return `data.union.type === "${t.name}" ? maybeNew${orNull}${t.name}(data["union"]["value"], {})`;
                  })
                  .join(" : ");
                return `${name}: (${types} : undefined) as ${defName}${operation}["${name}"]`;
              } else if (isScalarType(type)) {
                return `${name}: data["${name}"] || undefined`;
              } else {
                const orNull = field.type instanceof GraphQLNonNull ? "" : "OrNull";
                return `${name}: maybeNew${orNull}${
                  (type as GraphQLObjectType).name
                }(data["${name}"] || undefined, {}),`;
              }
            }
          }
        })}
      }
    }

    export function new${defName}Response(
      ${hasVariables ? `variables: ${defName}${operation}Variables,` : ""}
      data: ${defName}DataOptions | Error
    ): MockedResponse<${defName}${operation}Variables, ${defName}${operation}> {
      return {
        request: { query: ${defName}Document, ${hasVariables ? "variables, " : ""} },
        result: { data: data instanceof Error ? undefined : (new${defName}Data(data) as ${defName}${operation}) },
        error: data instanceof Error ? data : undefined,
      };
    }`;
}

const mockedResponse = `
  export type MockedResponse<V, Q> = {
    request: {
      query: any;
      variables?: V;
    };
    result: {
      data?: Q;
    };
    error?: Error;
  };
`;

function maybeDenull(o: GraphQLOutputType): GraphQLOutputType {
  return o instanceof GraphQLNonNull ? o.ofType : o;
}
