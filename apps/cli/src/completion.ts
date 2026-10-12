import type { Suggestion } from '@keel/core';

export type Shell = 'zsh' | 'bash';

// Both scripts hand the line up to the cursor to `keel __complete`, which answers
// from the same completer the browser terminal uses (people, projects, refs, dates).
const SCRIPTS: Record<Shell, string> = {
  zsh: `#compdef keel
_keel() {
  local -a items
  items=("\${(@f)$(keel __complete zsh "\${(j: :)words[1,CURRENT]}" 2>/dev/null)}")
  [[ -n "\${items[1]}" ]] && _describe -t keel 'keel' items
}
if (( ! $+functions[compdef] )); then autoload -Uz compinit && compinit; fi
compdef _keel keel
`,
  bash: `_keel() {
  local line="\${COMP_LINE:0:COMP_POINT}"
  local cur="\${line##* }"
  local IFS=$'\\n'
  local items=($(keel __complete bash "$line" 2>/dev/null))
  # Bash splits words on ":", so due:thu completes as "thu" after "due:".
  if [[ "$cur" == *:* ]]; then
    local prefix="\${cur%"\${cur##*:}"}"
    items=("\${items[@]#"$prefix"}")
  fi
  COMPREPLY=("\${items[@]}")
}
complete -F _keel keel
`,
};

export function isShell(value: string | undefined): value is Shell {
  return value === 'zsh' || value === 'bash';
}

export function completionScript(shell: Shell): string {
  return SCRIPTS[shell];
}

/** zsh's _describe wants "value:description" with colons in the value escaped; bash wants bare values. */
export function formatSuggestions(shell: Shell, suggestions: Suggestion[]): string {
  return suggestions
    .map((sug) => (shell === 'zsh' ? `${sug.insert.replace(/:/g, '\\:')}${sug.detail ? `:${sug.detail.replace(/\n/g, ' ')}` : ''}` : sug.insert))
    .join('\n');
}
