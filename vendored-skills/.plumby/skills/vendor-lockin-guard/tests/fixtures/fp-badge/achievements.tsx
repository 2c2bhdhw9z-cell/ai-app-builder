// FALSE POSITIVE guard (M31 comment-claim): prose about achievement badges is not a component.
// A game that calls its achievements badges mentions the word in comments and strings, but the
// component check matches only the rendered JSX construct, never the vocabulary.
//
// You earn a badge for each achievement. Badges are shown on your profile. The badge system
// does not phone home; badges are local.
export const label = 'badge';
export const message = 'You unlocked a new badge!';
