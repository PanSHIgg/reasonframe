package migrations

import "embed"

// FS contains the ordered SQL migrations applied by `rf migrate`.
//
//go:embed *.sql
var FS embed.FS
