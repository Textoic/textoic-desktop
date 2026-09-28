export const plainText = (markdown: string): string =>
  markdown
    .replace(/^---[ \t]*\n[\s\S]*?\n---[ \t]*(?=\n|$)/u, "")
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n[ \t]*\1[^\n]*/gmu, "$2")
    .replace(/`([^`\n]*)`/gu, "$1")
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/gu, "$1")
    .replace(/!?\[([^\]\n]*)\]\[[^\]\n]*\]/gu, "$1")
    .replace(/^[ \t]*#{1,6}[ \t]+/gmu, "")
    .replace(/^[ \t]*>[ \t]?/gmu, "")
    .replace(/^[ \t]*[-*+][ \t]+/gmu, "- ")
    .replace(/^[ \t]*[-=*_]{3,}[ \t]*$/gmu, "")
    .replace(/(\*\*|__)(.*?)\1/gu, "$2")
    .replace(/(\*|_)(.*?)\1/gu, "$2")
    .replace(/~~(.*?)~~/gu, "$1")
    .replace(/<\/?[a-zA-Z][^>\n]*>/gu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
