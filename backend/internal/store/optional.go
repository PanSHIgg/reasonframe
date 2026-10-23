package store

// Optional distinguishes "leave unchanged" from "set to NULL". It is used by
// the transactional job patch so callers do not need a separate update method
// for every state transition.
type Optional[T any] struct {
	Set   bool
	Value T
}

func Set[T any](value T) Optional[T] {
	return Optional[T]{Set: true, Value: value}
}

func SetPtr[T any](value *T) Optional[*T] {
	return Optional[*T]{Set: true, Value: value}
}

func Clear[T any]() Optional[*T] {
	return Optional[*T]{Set: true}
}
