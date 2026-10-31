import { usage } from "./output";

// The scripts `justnotes completion zsh|fish|bash` prints. They hold no
// command list: on every completion they run `justnotes __complete` with the
// words before the cursor and the current word, and offer the lines it
// prints (`word<TAB>description`, complete.ts). So plugin commands, their
// flags and the vault's notes appear without regenerating the script. A
// candidate ending in = or / (a parameter, a folder) takes no space after it.
// The shell completes --profile's folder itself.

const zsh = `#compdef justnotes
# justnotes completion for zsh: justnotes completion zsh > ~/.zfunc/_justnotes
# (with ~/.zfunc in fpath before compinit), or source <(justnotes completion zsh).
_justnotes() {
  if [[ \${words[CURRENT-1]} == --profile ]]; then
    _files -/
    return
  fi
  local -a lines spaced unspaced
  local line word item ret=1
  lines=("\${(@f)$(justnotes __complete "\${(@Q)words[2,CURRENT-1]}" "\${(Q)PREFIX}" 2>/dev/null)}")
  for line in $lines; do
    [[ -n $line ]] || continue
    word=\${line%%$'\\t'*}
    item=\${word//\\\\/\\\\\\\\}
    item=\${item//:/\\\\:}
    [[ $line == *$'\\t'* ]] && item+=":\${line#*$'\\t'}"
    if [[ $word == *[=/] ]]; then unspaced+=("$item"); else spaced+=("$item"); fi
  done
  (( $#unspaced )) && _describe -t parameters 'parameter' unspaced -S '' && ret=0
  (( $#spaced )) && _describe -t values 'justnotes' spaced && ret=0
  return ret
}
if [[ \${funcstack[1]} == _justnotes ]]; then
  _justnotes "$@"
else
  compdef _justnotes justnotes
fi`;

const fish = `# justnotes completion for fish: justnotes completion fish > ~/.config/fish/completions/justnotes.fish
function __justnotes_complete
    set -l words (commandline -xpc)
    set -e words[1]
    justnotes __complete $words (commandline -ct | string unescape) 2>/dev/null
end
complete -c justnotes -f
complete -c justnotes -n '__fish_prev_arg_in --profile' -F -a '(__fish_complete_directories)'
complete -c justnotes -n 'not __fish_prev_arg_in --profile' -a '(__justnotes_complete)'`;

// bash 3.2 (macOS) has no compopt, so the function is registered with
// nospace and adds the space itself. bash splits words at = and :, so
// replies drop what the current word holds up to its last one.
const bash = `# justnotes completion for bash: source <(justnotes completion bash)
_justnotes() {
  local line=\${COMP_LINE:0:COMP_POINT} cur="" word wb
  local -a parts
  read -a parts <<< "$line"
  if [[ $line != *" " || $line == *"\\\\ " ]]; then
    cur=\${parts[\${#parts[@]}-1]}
    unset "parts[\${#parts[@]}-1]"
  fi
  COMPREPLY=()
  if [[ \${parts[\${#parts[@]}-1]} == --profile ]]; then
    while IFS= read -r word; do COMPREPLY+=("$(printf '%q' "$word")/"); done < <(compgen -d -- "$cur")
    return
  fi
  wb=\${cur%"\${cur##*[=:]}"}
  while IFS= read -r word; do
    word=\${word%%$'\\t'*}
    [[ -n $word && $word == "$cur"* ]] || continue
    word=$(printf '%q' "\${word#"$wb"}")
    [[ $word == *[=/] ]] || word="$word "
    COMPREPLY+=("$word")
  done < <(justnotes __complete "\${parts[@]:1}" "$cur" 2>/dev/null)
}
complete -o nospace -F _justnotes justnotes`;

export function completionScript(shell: string) {
	if (shell === "zsh") return zsh;
	if (shell === "fish") return fish;
	if (shell === "bash") return bash;
	throw usage("Give the shell: justnotes completion zsh|fish|bash");
}
