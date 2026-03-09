export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      businesses: {
        Row: {
          id: string
          name: string
          type: string
          supports_tables: boolean
          requires_party_size: boolean
          public_screen_enabled: boolean
          created_at: string
          updated_at: string
          ai_chat_enabled: boolean
          auto_accept_reservations: boolean
          language: string
          whatsapp_phone_number: string | null | null
          whatsapp_session_id: string | null | null
          manual_table_occupancy_enabled: boolean
          public_join_enabled: boolean
        }
        Insert: {
          id?: string
          name: string
          type: string
          supports_tables: boolean
          requires_party_size: boolean
          public_screen_enabled: boolean
          created_at?: string
          updated_at?: string
          ai_chat_enabled: boolean
          auto_accept_reservations: boolean
          language: string
          whatsapp_phone_number?: string | null | null
          whatsapp_session_id?: string | null | null
          manual_table_occupancy_enabled: boolean
          public_join_enabled: boolean
        }
        Update: {
          id?: string
          name?: string
          type?: string
          supports_tables?: boolean
          requires_party_size?: boolean
          public_screen_enabled?: boolean
          created_at?: string
          updated_at?: string
          ai_chat_enabled?: boolean
          auto_accept_reservations?: boolean
          language?: string
          whatsapp_phone_number?: string | null | null
          whatsapp_session_id?: string | null | null
          manual_table_occupancy_enabled?: boolean
          public_join_enabled?: boolean
        }
        Relationships: []
      }
      customers: {
        Row: {
          id: string
          phone: string
          name: string
          first_seen_at: string
          last_seen_at: string
          created_at: string
          business_id: string
        }
        Insert: {
          id?: string
          phone: string
          name: string
          first_seen_at?: string
          last_seen_at?: string
          created_at?: string
          business_id: string
        }
        Update: {
          id?: string
          phone?: string
          name?: string
          first_seen_at?: string
          last_seen_at?: string
          created_at?: string
          business_id?: string
        }
        Relationships: []
      }
      tables: {
        Row: {
          id: string
          business_id: string
          table_number: string
          capacity: number
          is_active: boolean
          created_at: string
          updated_at: string
          is_occupied: boolean
          name: string
        }
        Insert: {
          id?: string
          business_id: string
          table_number: string
          capacity: number
          is_active: boolean
          created_at?: string
          updated_at?: string
          is_occupied: boolean
          name: string
        }
        Update: {
          id?: string
          business_id?: string
          table_number?: string
          capacity?: number
          is_active?: boolean
          created_at?: string
          updated_at?: string
          is_occupied?: boolean
          name?: string
        }
        Relationships: []
      }
      waitlist_entries: {
        Row: {
          id: string
          business_id: string
          customer_id: string
          party_size: number
          display_code: string
          queued_at: string
          notified_at: string | null | null
          seated_at: string | null | null
          created_at: string
          updated_at: string
          status: string
          table_id: string | null | null
          cancelled_at: string
          estimated_wait_minutes: string | null | null
          source: string
          confirmed_at: string
        }
        Insert: {
          id?: string
          business_id: string
          customer_id: string
          party_size: number
          display_code: string
          queued_at?: string
          notified_at?: string | null | null
          seated_at?: string | null | null
          created_at?: string
          updated_at?: string
          status: string
          table_id?: string | null | null
          cancelled_at?: string
          estimated_wait_minutes?: string | null | null
          source: string
          confirmed_at?: string
        }
        Update: {
          id?: string
          business_id?: string
          customer_id?: string
          party_size?: number
          display_code?: string
          queued_at?: string
          notified_at?: string | null | null
          seated_at?: string | null | null
          created_at?: string
          updated_at?: string
          status?: string
          table_id?: string | null | null
          cancelled_at?: string
          estimated_wait_minutes?: string | null | null
          source?: string
          confirmed_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

export type Tables<
  PublicTableNameOrOptions extends
    | keyof (Database["public"]["Tables"] & Database["public"]["Views"])
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof (Database[PublicTableNameOrOptions["schema"]]["Tables"] &
        Database[PublicTableNameOrOptions["schema"]]["Views"])
    : never = never
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? (Database[PublicTableNameOrOptions["schema"]]["Tables"] &
      Database[PublicTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : PublicTableNameOrOptions extends keyof (Database["public"]["Tables"] &
      Database["public"]["Views"])
  ? (Database["public"]["Tables"] &
      Database["public"]["Views"])[PublicTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  PublicTableNameOrOptions extends
    | keyof Database["public"]["Tables"]
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof Database[PublicTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? Database[PublicTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : PublicTableNameOrOptions extends keyof Database["public"]["Tables"]
  ? Database["public"]["Tables"][PublicTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  PublicTableNameOrOptions extends
    | keyof Database["public"]["Tables"]
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof Database[PublicTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? Database[PublicTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : PublicTableNameOrOptions extends keyof Database["public"]["Tables"]
  ? Database["public"]["Tables"][PublicTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  PublicEnumNameOrOptions extends
    | keyof Database["public"]["Enums"]
    | { schema: keyof Database },
  EnumName extends PublicEnumNameOrOptions extends { schema: keyof Database }
    ? keyof Database[PublicEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = PublicEnumNameOrOptions extends { schema: keyof Database }
  ? Database[PublicEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : PublicEnumNameOrOptions extends keyof Database["public"]["Enums"]
  ? Database["public"]["Enums"][PublicEnumNameOrOptions]
  : never
