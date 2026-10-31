// The `obsidian` module plugins require. Modules that also hold justnotes
// internals have their names listed one by one, so the module has exactly
// Obsidian's API; app code imports internals from their own modules.
export { App, type ObsidianProtocolData, RenderContext } from "./app";
export * from "./bases";
export {
	Editor,
	type EditorChange,
	type EditorCommandName,
	type EditorPosition,
	type EditorRange,
	type EditorRangeOrCaret,
	type EditorSelectionOrCaret,
	type EditorTransaction,
	editorEditorField,
	editorInfoField,
	editorLivePreviewField,
	editorViewField,
	livePreviewState,
} from "./editor";
export * from "./events";
export * from "./file-manager";
export * from "./icons";
export { type Command, type Hotkey, Keymap, type KeymapContext, type KeymapEventHandler, type KeymapInfo, type Modifier, Scope } from "./keymap";
export {
	finishRenderMath,
	loadMathJax,
	loadMermaid,
	loadPdfJs,
	loadPrism,
	type MarkdownPostProcessor,
	type MarkdownPostProcessorContext,
	MarkdownPreviewRenderer,
	MarkdownRenderChild,
	MarkdownRenderer,
	type MarkdownSectionInformation,
	renderMath,
} from "./markdown";
export { MarkdownEditView, MarkdownPreviewView, type MarkdownSubView } from "./markdown-preview";
export * from "./markdown-view";
export {
	type BlockCache,
	type BlockSubpathResult,
	type CachedMetadata,
	type CacheItem,
	type EmbedCache,
	type FootnoteCache,
	type FootnoteRefCache,
	type FootnoteSubpathResult,
	type FrontmatterLinkCache,
	type HeadingCache,
	type HeadingSubpathResult,
	type LinkCache,
	type ListItemCache,
	type Loc,
	MetadataCache,
	type Pos,
	type Reference,
	type ReferenceCache,
	type ReferenceLinkCache,
	type SectionCache,
	type TagCache,
} from "./metadata";
export {
	getAllTags,
	getFrontMatterInfo,
	getLinkpath,
	iterateCacheRefs,
	iterateRefs,
	parseFrontMatterAliases,
	parseFrontMatterEntry,
	parseFrontMatterStringArray,
	parseFrontMatterTags,
	parseLinktext,
	resolveSubpath,
	stripHeading,
	stripHeadingForLink,
} from "./metadata-utils";
export * from "./plugin";
export { sanitizeHTMLToDom } from "./sanitize";
export * from "./secret-storage";
export * from "./ui/menu";
export * from "./ui/modal";
export * from "./ui/notice";
export * from "./ui/popover";
export * from "./ui/setting";
export {
	AbstractInputSuggest,
	EditorSuggest,
	type EditorSuggestTriggerInfo,
	type FuzzyMatch,
	FuzzySuggestModal,
	type Instruction,
	PopoverSuggest,
	SuggestModal,
} from "./ui/suggest";
export { displayTooltip, type TooltipPlacement } from "./ui/tooltip";
export {
	apiVersion,
	arrayBufferToBase64,
	arrayBufferToHex,
	base64ToArrayBuffer,
	type Debouncer,
	debounce,
	getBlobArrayBuffer,
	getLanguage,
	hexToArrayBuffer,
	htmlToMarkdown,
	moment,
	normalizePath,
	Platform,
	parseYaml,
	prepareFuzzySearch,
	prepareSimpleSearch,
	type RequestUrlParam,
	type RequestUrlResponse,
	type RequestUrlResponsePromise,
	renderMatches,
	renderResults,
	request,
	requestUrl,
	type SearchResult,
	sortSearchResults,
	stringifyYaml,
} from "./util";
export * from "./vault";
export { EditableFileView, FileView, ItemView, TextFileView, View, type ViewCreator, type ViewState, type ViewStateResult } from "./view";
export {
	type OpenViewState,
	type PaneType,
	type Side,
	type SplitDirection,
	Tasks,
	Workspace,
	WorkspaceContainer,
	WorkspaceFloating,
	WorkspaceItem,
	WorkspaceLeaf,
	WorkspaceMobileDrawer,
	WorkspaceParent,
	WorkspaceRibbon,
	WorkspaceRoot,
	WorkspaceSidedock,
	WorkspaceSplit,
	WorkspaceTabs,
	WorkspaceWindow,
} from "./workspace";

import { apiVersion } from "./util";

export function requireApiVersion(version: string) {
	const have = apiVersion.split(".").map(Number);
	const want = version.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		if ((have[i] ?? 0) !== (want[i] ?? 0)) return (have[i] ?? 0) > (want[i] ?? 0);
	}
	return true;
}
