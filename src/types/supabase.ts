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
          city: string | null | null
          country: string | null | null
          cover_image_url: string | null | null
          description: string | null | null
          food_type: string | null | null
          listing_rejected_reason: string | null | null
          listing_status: string
          address: string | null | null
          address_lat: string | null | null
          address_lng: string | null | null
          address_osm_id: string | null | null
          last_jornada_closed_at: string | null | null
          weekly_hours: string | null | null
          reservation_opening_margin_minutes: number
          reservation_closing_margin_minutes: number
          future_reservations_blocked_for_date: string | null | null
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
          city?: string | null | null
          country?: string | null | null
          cover_image_url?: string | null | null
          description?: string | null | null
          food_type?: string | null | null
          listing_rejected_reason?: string | null | null
          listing_status: string
          address?: string | null | null
          address_lat?: string | null | null
          address_lng?: string | null | null
          address_osm_id?: string | null | null
          last_jornada_closed_at?: string | null | null
          weekly_hours?: string | null | null
          reservation_opening_margin_minutes: number
          reservation_closing_margin_minutes: number
          future_reservations_blocked_for_date?: string | null | null
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
          city?: string | null | null
          country?: string | null | null
          cover_image_url?: string | null | null
          description?: string | null | null
          food_type?: string | null | null
          listing_rejected_reason?: string | null | null
          listing_status?: string
          address?: string | null | null
          address_lat?: string | null | null
          address_lng?: string | null | null
          address_osm_id?: string | null | null
          last_jornada_closed_at?: string | null | null
          weekly_hours?: string | null | null
          reservation_opening_margin_minutes?: number
          reservation_closing_margin_minutes?: number
          future_reservations_blocked_for_date?: string | null | null
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
          lastName: string | null
        }
        Insert: {
          id?: string
          phone: string
          name: string
          first_seen_at?: string
          last_seen_at?: string
          created_at?: string
          business_id: string
          lastName?: string | null
        }
        Update: {
          id?: string
          phone?: string
          name?: string
          first_seen_at?: string
          last_seen_at?: string
          created_at?: string
          business_id?: string
          lastName?: string | null
        }
        Relationships: []
      }
      business_blocked_dates: {
        Row: {
          id: string
          business_id: string
          date: string
          reason: string | null
          reason_message: string | null
          created_at: string
        }
        Insert: {
          id?: string
          business_id: string
          date: string
          reason?: string | null
          reason_message?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          business_id?: string
          date?: string
          reason?: string | null
          reason_message?: string | null
          created_at?: string
        }
        Relationships: []
      }
      tables: {
        Row: {
          id: string
          business_id: string
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
          cancelled_at: string | null | null
          estimated_wait_minutes: string | null | null
          source: string
          confirmed_at: string | null
          scheduled_at: string | null
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
          cancelled_at?: string | null | null
          estimated_wait_minutes?: string | null | null
          source: string
          confirmed_at?: string | null
          scheduled_at?: string | null
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
          cancelled_at?: string | null | null
          estimated_wait_minutes?: string | null | null
          source?: string
          confirmed_at?: string | null
          scheduled_at?: string | null
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
