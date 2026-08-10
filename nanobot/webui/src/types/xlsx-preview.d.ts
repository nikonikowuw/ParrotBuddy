declare module "xlsx-preview" {
  export interface XlsxOptions {
    output?: "string" | "arrayBuffer";
    separateSheets?: boolean;
    minimumRows?: number;
    minimumCols?: number;
  }

  export function xlsx2Html(
    data: Blob | File | ArrayBuffer,
    options?: XlsxOptions,
  ): Promise<string | ArrayBuffer | string[] | ArrayBuffer[]>;

  const _default: {
    xlsx2Html: typeof xlsx2Html;
  };
  export default _default;
}
